import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { loadConfig } from '../config.ts';
import { SAMPLE_835, addCharge, seed } from '../claims/testkit.ts';
import { cernerLinesArrived, documentAppended } from '../coding/index.ts';
import { newId } from '../domain/ids.ts';
import type { IsoDate, IsoDateTime, MessageId } from '../domain/types.ts';
import { appendDocumentVersion } from '../ingest/upsert.ts';
import { buildRouter } from './routes.ts';

/** `charges` seeds two pass-through Cerner charges; the coding tests leave them out so a release is the only thing a claim can bill. */
const serve = async (opts: { charges?: boolean; env?: Record<string, string> } = {}) => {
  const s = seed();
  if (opts.charges ?? true) {
    addCharge(s, { externalId: 'T0001' });
    addCharge(s, { externalId: 'T0002', code: '36415', amount: 1700 as never });
  }
  const ingested: string[] = [];
  const router = buildRouter({ store: s.store, config: loadConfig(opts.env ?? {}), ingest: (raw) => { ingested.push(raw); return { ack: 'ACK', status: 'accepted' }; } });
  const server = http.createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown, contentType = 'application/json') => {
    const res = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }),
    });
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  return { ...s, ingested, call, close: () => new Promise<void>((r) => server.close(() => r())) };
};

test('claim lifecycle over HTTP: build, 837P, submit, post 835, AR summary', async () => {
  const t = await serve();
  try {
    const built = await t.call('POST', `/encounters/${t.encounterId}/claims`);
    assert.equal(built.status, 200);
    assert.equal(built.body.status, 'ready');
    assert.equal(built.body.controlNumber, 'FIN000123-1');
    assert.equal(built.body.totalCharge, 12550 + 1700);

    const again = await t.call('POST', `/encounters/${t.encounterId}/claims`);
    assert.equal(again.body.id, built.body.id, 'rebuilding with nothing new converges on the same claim');

    const edi = await t.call('GET', `/claims/${built.body.id}/837p`);
    assert.equal(edi.status, 200);
    assert.match(edi.body, /^ISA\*00\*/);
    assert.match(edi.body, /CLM\*FIN000123-1\*142\.50\*/);

    const submitted = await t.call('POST', `/claims/${built.body.id}/submit`);
    assert.equal(submitted.body.claim.status, 'submitted');
    assert.match(submitted.body.edi, /ST\*837\*/);

    const posted = await t.call('POST', '/remittances/835', SAMPLE_835, 'text/plain');
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.body[0], { controlNumber: 'FIN000123-1', posted: true, status: 'paid' });
    assert.equal(posted.body[1].posted, false, 'the second CLP names a claim we do not have');

    const detail = await t.call('GET', `/claims/${built.body.id}`);
    assert.deepEqual(detail.body.charges.map((c: { externalId: string; status: string; claimIds: string[] }) => [c.externalId, c.status, c.claimIds]),
      [['T0001', 'claimed', [built.body.id]], ['T0002', 'claimed', [built.body.id]]]);
    assert.equal((await t.call('GET', '/charges?source=cerner_dft&status=claimed')).body.length, 2);
    assert.equal((await t.call('GET', '/charges?source=coder')).body.length, 0);
    assert.equal((await t.call('GET', '/charges?source=paper')).status, 400);
    assert.equal(detail.body.payments.length, 1);
    assert.equal(detail.body.events.at(-1).to, 'paid');

    const ar = await t.call('GET', '/ar/summary');
    assert.deepEqual(ar.body.map((r: { status: string; count: number }) => [r.status, r.count]), [['paid', 1]]);
  } finally {
    await t.close();
  }
});

test('domain errors map to HTTP statuses at the boundary', async () => {
  const t = await serve();
  try {
    assert.equal((await t.call('GET', '/claims/nope')).status, 404);
    assert.equal((await t.call('POST', '/encounters/nope/claims')).status, 404);
    const built = await t.call('POST', `/encounters/${t.encounterId}/claims`);
    const ack = await t.call('POST', `/claims/${built.body.id}/acknowledge`, { accepted: true });
    assert.equal(ack.status, 409, 'ready → accepted is not a legal transition');
    assert.match(ack.body.error, /cannot move from ready to accepted/);
    assert.equal((await t.call('GET', '/claims?status=bogus')).status, 400);
    assert.equal((await t.call('POST', '/remittances', { controlNumber: 'x' })).status, 400);
  } finally {
    await t.close();
  }
});

test('raw HL7 posted over HTTP goes through ingest and returns its ACK', async () => {
  const t = await serve();
  try {
    const res = await t.call('POST', '/hl7', 'MSH|^~\\&|CERNER|HOSP|||20261105||ADT^A04|1|P|2.5.1\r', 'text/plain');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');
    assert.equal(t.ingested.length, 1);
    assert.equal((await t.call('POST', '/hl7')).status, 400);
  } finally {
    await t.close();
  }
});

const AT = '2026-11-08T18:00:00.000Z' as IsoDateTime;
const CODING = { mode: 'coder' as const, documentationGraceHours: 48, qaSamplePercent: 0 };

/** The seeded encounter with a final note, one Cerner proposal line plus its FT1-19 diagnosis, and so a ready_to_code task. */
const serveCoding = async (env: Record<string, string> = {}) => {
  const t = await serve({ charges: false, env });
  const encounter = t.store.getEncounter(t.encounterId)!;
  cernerLinesArrived(t.store, encounter, [{
    sourceRef: 'T0001', reversal: false, diagnoses: [{ code: 'R07.9', description: 'Chest pain' }],
    procedure: { kind: 'procedure', codeSystem: 'CPT', code: '99213', modifiers: ['25'], units: 1, serviceDate: '2026-10-02' as IsoDate, diagnosisCodes: ['R07.9'] },
  }], { now: AT, messageId: newId<MessageId>() }, CODING);
  const appended = appendDocumentVersion(t.store, t.encounterId, newId<MessageId>(), {
    externalId: 'DOC0001', kind: 'progress_note', status: 'final', title: 'Progress Note', body: 'Chest pain.', author: { npi: '1234567893', lastName: 'Smith', firstName: 'Robert' },
    signedAt: '2026-10-03T18:00:00Z' as IsoDateTime,
  }, AT);
  documentAppended(t.store, encounter, appended, AT);
  const task = t.store.findTaskByEncounter(t.encounterId)!;
  return { ...t, task, documentId: appended.document.id };
};

test('coding over HTTP: queue, task view, assign, start, codes, query hold and resume', async () => {
  const t = await serveCoding();
  try {
    const queue = await t.call('GET', '/coding/tasks?status=ready_to_code');
    assert.deepEqual(queue.body.map((x: { id: string }) => x.id), [t.task.id]);
    assert.equal((await t.call('GET', '/coding/tasks?status=bogus')).status, 400);
    assert.equal((await t.call('GET', '/coding/tasks?overdue=true&asOf=nope')).status, 400);
    assert.deepEqual((await t.call('GET', '/coding/tasks?overdue=true&asOf=2030-01-01T00:00:00Z')).body, [], 'a ready task is not awaiting documentation');

    const view = await t.call('GET', `/coding/tasks/${t.task.id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.task.status, 'ready_to_code');
    assert.equal(view.body.patient.id, t.patientId);
    assert.deepEqual(view.body.documents.map((d: { current: { externalId: string } }) => d.current.externalId), ['DOC0001']);
    assert.equal(view.body.codes.lines.length, 2);
    assert.deepEqual(view.body.codes.violations.map((v: { rule: string }) => v.rule), ['proposals-decided', 'proposals-decided', 'procedure-present', 'diagnosis-present'], 'the edits run on read');
    assert.deepEqual(view.body.events.map((e: { to: string }) => e.to), ['awaiting_documentation', 'ready_to_code'], 'the DFT opened it, the note made it ready');

    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/assign`, { assignee: 'coder-1' })).body.assignee, 'coder-1');
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/start`, { coder: 'coder-2' })).status, 409);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/start`, {})).status, 400);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/start`, { coder: 'coder-1' })).body.status, 'in_progress');

    const codes = await t.call('GET', `/coding/tasks/${t.task.id}/codes`);
    const pending = codes.body.lines.filter((l: { pending: boolean }) => l.pending);
    assert.equal(pending.length, 2);
    const edited = await t.call('POST', `/coding/tasks/${t.task.id}/codes`, {
      coder: 'coder-1',
      edits: [
        ...pending.map((l: { lineId: string; current: { id: string } }) => ({ op: 'accept', lineId: l.lineId, basedOn: l.current.id })),
        { op: 'add', content: { kind: 'diagnosis', code: 'I10', sequence: 2 } },
      ],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.lines.length, 3);
    assert.ok(edited.body.lines.every((l: { pending: boolean }) => !l.pending));
    const stale = await t.call('POST', `/coding/tasks/${t.task.id}/codes`, { coder: 'coder-1', edits: [{ op: 'remove', lineId: pending[0].lineId, basedOn: pending[0].current.id }] });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /based on/);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/codes`, { coder: 'coder-1', edits: [{ op: 'add', content: { kind: 'procedure', code: '99213', units: 1.5, serviceDate: '2026-10-02' } }] })).status, 400);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/codes`, { coder: 'coder-1', edits: [{ op: 'add', content: { kind: 'procedure', code: '99213', serviceDate: '10/02/2026' } }] })).status, 400);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/codes`, { coder: 'coder-1', edits: [{ op: 'void', lineId: 'x', basedOn: 'y' }] })).status, 400);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/codes`, { coder: 'coder-1', edits: [] })).status, 400);

    const held = await t.call('POST', `/coding/tasks/${t.task.id}/queries`, { coder: 'coder-1', question: 'Confirm total time', channel: 'in_app' });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.equal(held.body.task.status, 'on_hold_query');
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/codes`, { coder: 'coder-1', edits: [{ op: 'add', content: { kind: 'diagnosis', code: 'E11.9', sequence: 3 } }] })).status, 409, 'codes are frozen on hold');
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/queries`, { coder: 'coder-1', question: 'Another', channel: 'fax' })).status, 400);
    const answered = await t.call('POST', `/coding/queries/${held.body.query.id}/answer`, { answer: '22 minutes' });
    assert.equal(answered.body.task.status, 'in_progress');
    assert.equal((await t.call('POST', `/coding/queries/${held.body.query.id}/answer`, { answer: '35 minutes' })).status, 409);
    assert.equal((await t.call('POST', '/coding/queries/nope/answer', { answer: 'x' })).status, 404);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/reopen`, { reason: 'not released' })).status, 409);
    assert.equal((await t.call('GET', '/coding/tasks/nope')).status, 404);

    const final = await t.call('GET', `/coding/tasks/${t.task.id}`);
    assert.deepEqual(final.body.events.map((e: { to: string }) => e.to), ['awaiting_documentation', 'ready_to_code', 'in_progress', 'on_hold_query', 'in_progress']);
    assert.equal(final.body.queries.length, 1);
  } finally {
    await t.close();
  }
});

const FEES = { lines: [{ code: '99213', modifiers: [], amount: 12500, effectiveFrom: '2026-01-01' }] };
const acceptAll = async (t: Awaited<ReturnType<typeof serveCoding>>) => {
  await t.call('POST', `/coding/tasks/${t.task.id}/start`, { coder: 'coder-1' });
  const codes = await t.call('GET', `/coding/tasks/${t.task.id}/codes`);
  const pending = codes.body.lines.filter((l: { pending: boolean }) => l.pending);
  await t.call('POST', `/coding/tasks/${t.task.id}/codes`, { coder: 'coder-1', edits: pending.map((l: { lineId: string; current: { id: string } }) => ({ op: 'accept', lineId: l.lineId, basedOn: l.current.id })) });
};

test('release over HTTP: fee schedule round trip, 422 with the violations, then a release that returns the built claim', async () => {
  const t = await serveCoding();
  try {
    await acceptAll(t);
    const blocked = await t.call('POST', `/coding/tasks/${t.task.id}/release`, { coder: 'coder-1' });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error, 'coding edits failed');
    assert.deepEqual(blocked.body.detail.map((v: { rule: string; severity: string }) => [v.rule, v.severity]), [['fee-on-file', 'error']]);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/release`, {})).status, 400);

    assert.equal((await t.call('PUT', '/fee-schedule', { lines: [{ code: '99213', amount: -1, effectiveFrom: '2026-01-01' }] })).status, 400, 'FeeScheduleError is a 400');
    assert.equal((await t.call('PUT', '/fee-schedule', { lines: [{ code: '99213', amount: '125', effectiveFrom: '2026-01-01' }] })).status, 400);
    assert.equal((await t.call('PUT', '/fee-schedule', { lines: [{ code: '99213', amount: 12500, effectiveFrom: '01/01/2026' }] })).status, 400);
    const put = await t.call('PUT', '/fee-schedule', FEES);
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, [{ code: '99213', modifiers: [], amount: 12500, effectiveFrom: '2026-01-01' }]);
    assert.deepEqual((await t.call('GET', '/fee-schedule')).body, put.body);

    const out = await t.call('POST', `/coding/tasks/${t.task.id}/release`, { coder: 'coder-1' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.kind, 'released');
    assert.deepEqual([out.body.releaseNumber, out.body.charges.created.length, out.body.charges.voided, out.body.charges.kept], [1, 1, [], []]);
    assert.deepEqual([out.body.claim.kind, out.body.claim.claim.status, out.body.claim.claim.totalCharge], ['built', 'ready', 12500]);
    assert.deepEqual((await t.call('GET', `/charges?encounterId=${t.encounterId}&source=coder`)).body.map((c: { amount: number; status: string }) => [c.amount, c.status]), [[12500, 'claimed']]);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/qa`, { reviewer: 'lead-1', outcome: 'agree' })).status, 409, 'nothing is in QA');
  } finally {
    await t.close();
  }
});

test('QA over HTTP: sampled releases wait in qa_review; return needs notes; agree releases and builds', async () => {
  const t = await serveCoding({ QA_SAMPLE_PERCENT: '100' });
  try {
    await acceptAll(t);
    await t.call('PUT', '/fee-schedule', FEES);
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/release`, { coder: 'coder-1' })).body.kind, 'qa_review');
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/qa`, { reviewer: 'lead-1', outcome: 'return' })).status, 400, 'a return carries notes');
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/qa`, { reviewer: 'lead-1', outcome: 'maybe' })).status, 400);
    const back = await t.call('POST', `/coding/tasks/${t.task.id}/qa`, { reviewer: 'lead-1', outcome: 'return', notes: 'add I10' });
    assert.deepEqual([back.body.kind, back.body.task.status], ['returned', 'returned_to_coder']);
    await t.call('POST', `/coding/tasks/${t.task.id}/start`, { coder: 'coder-1' });
    assert.equal((await t.call('POST', `/coding/tasks/${t.task.id}/release`, { coder: 'coder-1' })).body.kind, 'qa_review');
    await t.call('PUT', '/fee-schedule', { lines: [] });
    const blocked = await t.call('POST', `/coding/tasks/${t.task.id}/qa`, { reviewer: 'lead-1', outcome: 'agree' });
    assert.equal(blocked.status, 422);
    assert.deepEqual(blocked.body.detail.map((v: { rule: string }) => v.rule), ['fee-on-file']);
    await t.call('PUT', '/fee-schedule', FEES);
    const agreed = await t.call('POST', `/coding/tasks/${t.task.id}/qa`, { reviewer: 'lead-1', outcome: 'agree', notes: 'fine' });
    assert.deepEqual([agreed.body.kind, agreed.body.task.status, agreed.body.claim.kind], ['released', 'released', 'built']);
    const view = await t.call('GET', `/coding/tasks/${t.task.id}`);
    assert.equal(view.body.qaSampled, true);
    assert.deepEqual(view.body.events.map((e: { to: string }) => e.to), ['awaiting_documentation', 'ready_to_code', 'in_progress', 'coded', 'qa_review', 'returned_to_coder', 'in_progress', 'coded', 'qa_review', 'released']);
  } finally {
    await t.close();
  }
});

test('documents over HTTP and on the encounter detail', async () => {
  const t = await serveCoding();
  try {
    const list = await t.call('GET', `/documents?encounterId=${t.encounterId}`);
    assert.deepEqual(list.body.map((d: { current: { id: string }; priorVersions: unknown[] }) => [d.current.id, d.priorVersions.length]), [[t.documentId, 0]]);
    assert.equal((await t.call('GET', '/documents')).status, 400);
    const one = await t.call('GET', `/documents/${t.documentId}`);
    assert.equal(one.body.externalId, 'DOC0001');
    assert.equal(one.body.versions.length, 1);
    assert.equal((await t.call('GET', '/documents/nope')).status, 404);
    const enc = await t.call('GET', `/encounters/${t.encounterId}`);
    assert.equal(enc.body.documents.length, 1);
    assert.equal(enc.body.task.id, t.task.id);
  } finally {
    await t.close();
  }
});
