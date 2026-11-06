// The coder's view: the coding-time context the edits read, the code set with its
// violations, and the task screen read model (SPEC 7.2). Writes here are only the coder
// edit entry point, which delegates the append to codes.ts.

import type { BillingProviderConfig } from '../claims/index.ts';
import type { Store } from '../db/store.ts';
import { nowIso } from '../domain/ids.ts';
import type {
  CodingTask, CodingTaskEvent, CodingTaskId, Coverage, Document, Encounter, IsoDateTime, Patient, Provider, ProviderQuery, ScrubViolation,
} from '../domain/types.ts';
import { activeCodes, deriveCodeSet, recordCoderEdits, type CodeEdit, type CodeLine, type CodeSet } from './codes.ts';
import { runCodingEdits } from './edits.ts';
import { planRelease, type LiveCharge, type ReleasePlan } from './plan.ts';
import { requireTask } from './state.ts';

/**
 * Read model for coding edits, ClaimContext's twin. Built once per check; rules are pure
 * functions of it. `plan` is what release would write right now.
 */
export interface CodingContext {
  task: CodingTask;
  encounter: Encounter;
  /** Priority 1. Absent is a warning at coding time and NoCoverageError at claim build. */
  coverage?: Coverage;
  /** Current version of each document, latest signed first. */
  documents: Document[];
  codes: CodeSet;
  plan: ReleasePlan;
}

/** Non-voided coder charges of the encounter with the status of every claim they sit on. */
const liveCoderCharges = (store: Store, encounterId: Encounter['id']): LiveCharge[] => store.listCharges({ encounterId, source: 'coder' }).flatMap((c) => {
  if (c.source !== 'coder' || c.status === 'voided') return [];
  const claims = c.claimIds.flatMap((id) => { const claim = store.getClaim(id); return claim ? [{ id, status: claim.status }] : []; });
  return [{ charge: c, claims }];
});

/** Author of the latest current final or corrected document, else the encounter's attending provider. */
const defaultRendering = (documents: readonly Document[], encounter: Encounter): Provider | undefined =>
  documents.find((d) => d.status !== 'preliminary' && d.author)?.author ?? encounter.attendingProvider;

/** Loads encounter, coverage, current documents, code log, fee schedule and live coder charges with claim statuses; derives the set and the plan. */
export function loadCodingContext(store: Store, taskId: CodingTaskId): CodingContext {
  const task = requireTask(store, taskId);
  const encounter = store.getEncounter(task.encounterId);
  if (!encounter) throw new Error(`coding task ${taskId}: encounter ${task.encounterId} not found`);
  const coverage = store.listCoverages(encounter.id).find((c) => c.priority === 1);
  const documents = summarizeDocuments(store.listDocuments(encounter.id)).map((d) => d.current);
  const codes = deriveCodeSet(store.listCodeAssignments(encounter.id));
  const rendering = defaultRendering(documents, encounter);
  return {
    task,
    encounter,
    ...(coverage ? { coverage } : {}),
    documents,
    codes,
    plan: planRelease({ codes: activeCodes(codes), schedule: store.listFeeSchedule(), live: liveCoderCharges(store, encounter.id), ...(rendering ? { defaultRendering: rendering } : {}) }),
  };
}

export interface CodesView {
  lines: readonly CodeLine[];
  /** All edit findings, errors and warnings, as release would see them now. */
  violations: ScrubViolation[];
}

const view = (ctx: CodingContext, billing: BillingProviderConfig): CodesView => ({ lines: ctx.codes.lines, violations: runCodingEdits(ctx, billing) });

/** GET /coding/tasks/:id/codes. Edits fire on read as well as on release (SPEC 7.2 "on entry"). */
export function readCodes(store: Store, billing: BillingProviderConfig, taskId: CodingTaskId): CodesView {
  return view(loadCodingContext(store, taskId), billing);
}

export class TaskNotEditableError extends Error {
  constructor(taskId: CodingTaskId, status: string) {
    super(`coding task ${taskId} is ${status}; codes change only while in_progress`);
    this.name = 'TaskNotEditableError';
  }
}

/**
 * POST /coding/tasks/:id/codes. Requires status in_progress (so the code set is frozen
 * during QA and after release; a reopen is the way back). Appends the batch atomically
 * and returns the new view with its violations.
 */
export function editCodes(store: Store, billing: BillingProviderConfig, taskId: CodingTaskId, coder: string, edits: readonly CodeEdit[], at: IsoDateTime = nowIso()): CodesView {
  const task = requireTask(store, taskId);
  if (task.status !== 'in_progress') throw new TaskNotEditableError(taskId, task.status);
  recordCoderEdits(store, task.encounterId, coder, edits, at);
  return readCodes(store, billing, taskId);
}

export interface DocumentSummary {
  current: Document;
  /** Older versions, newest first. */
  priorVersions: readonly Pick<Document, 'id' | 'version' | 'status' | 'recordedAt'>[];
}

/** Groups store.listDocuments output (versions newest first within each document) into current version plus history. */
export function summarizeDocuments(versions: readonly Document[]): DocumentSummary[] {
  const out: { current: Document; priorVersions: DocumentSummary['priorVersions'][number][] }[] = [];
  for (const d of versions) {
    const last = out[out.length - 1];
    if (last && last.current.externalId === d.externalId) last.priorVersions.push({ id: d.id, version: d.version, status: d.status, recordedAt: d.recordedAt });
    else out.push({ current: d, priorVersions: [] });
  }
  return out;
}

/** GET /coding/tasks/:id: everything the coding screen shows, one call. */
export interface TaskView {
  task: CodingTask;
  events: CodingTaskEvent[];
  patient: Patient;
  encounter: Encounter;
  coverages: Coverage[];
  documents: DocumentSummary[];
  codes: CodesView;
  queries: ProviderQuery[];
  /** Derived from events: the last `coded` event was followed by qa_review. */
  qaSampled: boolean;
  /** awaiting_documentation and documentationDueAt <= asOf. */
  documentationOverdue: boolean;
}

export function loadTaskView(store: Store, billing: BillingProviderConfig, taskId: CodingTaskId, asOf: IsoDateTime = nowIso()): TaskView {
  const ctx = loadCodingContext(store, taskId);
  const patient = store.getPatient(ctx.encounter.patientId);
  if (!patient) throw new Error(`coding task ${taskId}: patient ${ctx.encounter.patientId} not found`);
  const events = store.listTaskEvents(taskId);
  const lastCoded = events.findLastIndex((e) => e.to === 'coded');
  return {
    task: ctx.task,
    events,
    patient,
    encounter: ctx.encounter,
    coverages: store.listCoverages(ctx.encounter.id),
    documents: summarizeDocuments(store.listDocuments(ctx.encounter.id)),
    codes: view(ctx, billing),
    queries: store.listQueries(taskId),
    qaSampled: lastCoded >= 0 && events[lastCoded + 1]?.to === 'qa_review',
    documentationOverdue: ctx.task.status === 'awaiting_documentation' && ctx.task.documentationDueAt !== undefined && ctx.task.documentationDueAt <= asOf,
  };
}
