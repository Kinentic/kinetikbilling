// Coding, document and fee-schedule routes (SPEC 11 subset), mounted by buildRouter. Each
// handler narrows the body, calls one coding function, returns plain data. HTTP to SQL is at
// most this file, coding/<module>.ts, db/store.ts.

import {
  answerQuery, assignTask, editCodes, loadTaskView, raiseQuery, readCodes, release, reopenTask, replaceFeeSchedule, reviewQa, startTask, summarizeDocuments,
  type CodeEdit, type QaDecision,
} from '../coding/index.ts';
import type { AppConfig } from '../config.ts';
import type { Store } from '../db/store.ts';
import { nowIso } from '../domain/ids.ts';
import type {
  Cents, ChargeCodeSystem, CodeAssignmentId, CodeContent, CodeLineId, CodingTaskId, DocumentId, EncounterId, FeeScheduleLine, IsoDate, IsoDateTime, Provider,
  ProviderQueryId, QueryChannel, Specialty, TaskStatus,
} from '../domain/types.ts';
import { HttpError, Router, oneOf, requireObject, requireString } from './router.ts';

const TASK_STATUSES: readonly TaskStatus[] = ['awaiting_documentation', 'ready_to_code', 'in_progress', 'on_hold_query', 'coded', 'qa_review', 'returned_to_coder', 'released'];
const SPECIALTIES: readonly Specialty[] = ['primary_care', 'radiology'];
const CHANNELS: readonly QueryChannel[] = ['in_app', 'email', 'cerner_message', 'verbal'];
const CODE_SYSTEMS: readonly ChargeCodeSystem[] = ['CPT', 'HCPCS', 'REV', 'OTHER'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const optionalString = (o: Record<string, unknown>, key: string): string | undefined => {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') throw new HttpError(400, `body.${key} must be a non-empty string`);
  return v;
};

const instant = (value: string | null, label: string): IsoDateTime | undefined => {
  if (value === null) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new HttpError(400, `${label} must be an ISO 8601 instant`);
  return new Date(value).toISOString() as IsoDateTime;
};

/** Body narrowing for the `edits` array of POST /coding/tasks/:id/codes. */
export function parseCodeEdits(body: unknown): CodeEdit[] {
  const edits = requireObject(body).edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new HttpError(400, 'body.edits must be a non-empty array');
  return edits.map((raw, i) => {
    const where = `body.edits[${i}]`;
    const e = requireObject(raw);
    const op = oneOf(typeof e.op === 'string' ? e.op : '', ['add', 'change', 'remove', 'accept'] as const, `${where}.op`)!;
    if (op === 'add') {
      const queryId = optionalString(e, 'queryId') as ProviderQueryId | undefined;
      return { op, content: parseContent(e.content, `${where}.content`), ...(queryId ? { queryId } : {}) };
    }
    const lineId = requireString(e, 'lineId') as CodeLineId;
    const basedOn = requireString(e, 'basedOn') as CodeAssignmentId;
    return op === 'change' ? { op, lineId, basedOn, content: parseContent(e.content, `${where}.content`) } : { op, lineId, basedOn };
  });
}

const stringList = (v: unknown, label: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `${label} must be an array of strings`);
  return v as string[];
};

const provider = (v: unknown, label: string): Provider | undefined => {
  if (v === undefined) return undefined;
  const o = requireObject(v);
  return { npi: requireString(o, 'npi'), lastName: requireString(o, 'lastName'), firstName: requireString(o, 'firstName'), ...(typeof o.middleName === 'string' ? { middleName: o.middleName } : {}) };
};

function parseContent(raw: unknown, where: string): CodeContent {
  const c = requireObject(raw);
  const code = requireString(c, 'code');
  if (c.kind === 'diagnosis') {
    if (typeof c.sequence !== 'number' || !Number.isInteger(c.sequence) || c.sequence < 1) throw new HttpError(400, `${where}.sequence must be a positive integer`);
    const description = optionalString(c, 'description');
    return { kind: 'diagnosis', code, sequence: c.sequence, ...(description ? { description } : {}) };
  }
  if (c.kind !== 'procedure') throw new HttpError(400, `${where}.kind must be procedure or diagnosis`);
  const units = c.units ?? 1;
  if (typeof units !== 'number' || !Number.isInteger(units) || units < 1) throw new HttpError(400, `${where}.units must be a positive integer`);
  const serviceDate = requireString(c, 'serviceDate');
  if (!ISO_DATE.test(serviceDate)) throw new HttpError(400, `${where}.serviceDate must be YYYY-MM-DD`);
  const renderingProvider = provider(c.renderingProvider, `${where}.renderingProvider`);
  return {
    kind: 'procedure',
    codeSystem: oneOf(typeof c.codeSystem === 'string' ? c.codeSystem : 'CPT', CODE_SYSTEMS, `${where}.codeSystem`)!,
    code,
    modifiers: stringList(c.modifiers, `${where}.modifiers`),
    units,
    serviceDate: serviceDate as IsoDate,
    ...(renderingProvider ? { renderingProvider } : {}),
    diagnosisCodes: stringList(c.diagnosisCodes, `${where}.diagnosisCodes`),
  };
}

const isoDate = (o: Record<string, unknown>, key: string, where: string): IsoDate => {
  const v = requireString(o, key);
  if (!ISO_DATE.test(v)) throw new HttpError(400, `${where}.${key} must be YYYY-MM-DD`);
  return v as IsoDate;
};

/** Body narrowing for PUT /fee-schedule {lines}. Amount must be a number here; the integer, sign and range rules are FeeScheduleError (400). */
export function parseFeeLines(body: unknown): FeeScheduleLine[] {
  const lines = requireObject(body).lines;
  if (!Array.isArray(lines)) throw new HttpError(400, 'body.lines must be an array');
  return lines.map((raw, i) => {
    const where = `body.lines[${i}]`;
    const l = requireObject(raw);
    if (typeof l.amount !== 'number') throw new HttpError(400, `${where}.amount must be a number of cents`);
    const effectiveTo = l.effectiveTo === undefined ? undefined : isoDate(l, 'effectiveTo', where);
    return {
      code: requireString(l, 'code'), modifiers: stringList(l.modifiers, `${where}.modifiers`), amount: l.amount as Cents, effectiveFrom: isoDate(l, 'effectiveFrom', where),
      ...(effectiveTo ? { effectiveTo } : {}),
    };
  });
}

const parseQaDecision = (body: unknown): QaDecision => {
  const o = requireObject(body);
  const reviewer = requireString(o, 'reviewer');
  const outcome = oneOf(typeof o.outcome === 'string' ? o.outcome : '', ['agree', 'return'] as const, 'body.outcome')!;
  const notes = optionalString(o, 'notes');
  if (outcome === 'return') return { outcome, reviewer, notes: requireString(o, 'notes') };
  return { outcome, reviewer, ...(notes ? { notes } : {}) };
};

/**
 * GET  /documents?encounterId=              current versions, latest signed first
 * GET  /documents/:id                       one version plus every version of its externalId
 * GET  /coding/tasks?status=&assignee=&specialty=&overdue=true&asOf=
 *                                           queues; overdue=true lists awaiting_documentation tasks past documentationDueAt as of asOf (default now)
 * GET  /coding/tasks/:id?asOf=              the coding screen in one read
 * POST /coding/tasks/:id/assign   {assignee}
 * POST /coding/tasks/:id/start    {coder}
 * POST /coding/tasks/:id/release  {coder, warningsAcknowledged?}  release; blocked -> 422 with the violations as detail
 * POST /coding/tasks/:id/reopen   {reason, actor?}
 * POST /coding/tasks/:id/qa       {reviewer, outcome, notes?}     reviewQa; blocked -> 422
 * GET  /coding/tasks/:id/codes
 * POST /coding/tasks/:id/codes    {coder, edits: CodeEdit[]}
 * POST /coding/tasks/:id/queries  {coder, question, channel, sentTo?}   (this is "hold")
 * POST /coding/queries/:id/answer {answer}                              (this is "resume")
 * GET  /fee-schedule
 * PUT  /fee-schedule              {lines: FeeScheduleLine[]}      whole-set replacement
 */
export function addCodingRoutes(r: Router, { store, config }: { store: Store; config: AppConfig }): void {
  const deps = { billing: config.billing, qaSamplePercent: config.coding.qaSamplePercent };
  const unlessBlocked = (out: ReturnType<typeof reviewQa>) => {
    if (out.kind === 'blocked') throw new HttpError(422, 'coding edits failed', out.violations);
    return out;
  };

  r.add('GET', '/documents', ({ query }) => {
    const encounterId = query.get('encounterId');
    if (!encounterId) throw new HttpError(400, 'encounterId is required');
    return summarizeDocuments(store.listDocuments(encounterId as EncounterId));
  });
  r.add('GET', '/documents/:id', ({ params }) => {
    const document = store.getDocument(params.id as DocumentId);
    if (!document) throw new HttpError(404, `document ${params.id} not found`);
    return { ...document, versions: store.listDocuments(document.encounterId).filter((d) => d.externalId === document.externalId) };
  });

  r.add('GET', '/coding/tasks', ({ query }) => {
    const status = oneOf(query.get('status'), TASK_STATUSES, 'status');
    const specialty = oneOf(query.get('specialty'), SPECIALTIES, 'specialty');
    const assignee = query.get('assignee');
    const overdue = query.get('overdue') === 'true';
    return store.listTasks({
      ...(status ? { status } : {}),
      ...(specialty ? { specialty } : {}),
      ...(assignee ? { assignee } : {}),
      ...(overdue ? { documentationOverdueAt: instant(query.get('asOf'), 'asOf') ?? nowIso() } : {}),
    });
  });
  r.add('GET', '/coding/tasks/:id', ({ params, query }) => loadTaskView(store, config.billing, params.id as CodingTaskId, instant(query.get('asOf'), 'asOf')));
  r.add('POST', '/coding/tasks/:id/assign', ({ params, body }) => assignTask(store, params.id as CodingTaskId, requireString(body, 'assignee')));
  r.add('POST', '/coding/tasks/:id/start', ({ params, body }) => startTask(store, params.id as CodingTaskId, requireString(body, 'coder')));
  r.add('POST', '/coding/tasks/:id/release', ({ params, body }) => {
    const ack = optionalString(requireObject(body), 'warningsAcknowledged');
    return unlessBlocked(release(store, deps, params.id as CodingTaskId, { coder: requireString(body, 'coder'), ...(ack ? { warningsAcknowledged: ack } : {}) }));
  });
  r.add('POST', '/coding/tasks/:id/reopen', ({ params, body }) => reopenTask(store, params.id as CodingTaskId, requireString(body, 'reason'), optionalString(requireObject(body), 'actor')));
  r.add('POST', '/coding/tasks/:id/qa', ({ params, body }) => unlessBlocked(reviewQa(store, deps, params.id as CodingTaskId, parseQaDecision(body))));

  r.add('GET', '/coding/tasks/:id/codes', ({ params }) => readCodes(store, config.billing, params.id as CodingTaskId));
  r.add('POST', '/coding/tasks/:id/codes', ({ params, body }) => editCodes(store, config.billing, params.id as CodingTaskId, requireString(body, 'coder'), parseCodeEdits(body)));

  r.add('POST', '/coding/tasks/:id/queries', ({ params, body }) => {
    const o = requireObject(body);
    const sentTo = provider(o.sentTo, 'body.sentTo');
    return raiseQuery(store, params.id as CodingTaskId, {
      coder: requireString(body, 'coder'), question: requireString(body, 'question'),
      channel: oneOf(typeof o.channel === 'string' ? o.channel : '', CHANNELS, 'body.channel')!,
      ...(sentTo ? { sentTo } : {}),
    });
  });
  r.add('POST', '/coding/queries/:id/answer', ({ params, body }) => answerQuery(store, params.id as ProviderQueryId, requireString(body, 'answer')));

  r.add('GET', '/fee-schedule', () => store.listFeeSchedule());
  r.add('PUT', '/fee-schedule', ({ body }) => replaceFeeSchedule(store, parseFeeLines(body)));
}
