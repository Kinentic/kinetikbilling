import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCoderCharge, cfg, seed } from '../claims/testkit.ts';
import { buildClaim } from '../claims/index.ts';
import { newId } from '../domain/ids.ts';
import type { CodingTask, CodingTaskId, MessageId, TaskStatus } from '../domain/types.ts';
import { appendDocumentVersion } from '../ingest/upsert.ts';
import { deriveCodeSet } from './codes.ts';
import { InvalidTaskTransitionError, TASK_TRANSITIONS } from './state.ts';
import {
  TaskAssignedElsewhereError, addHours, assignTask, cernerLinesArrived, documentAppended, reactToFact, reopenTask, startTask, visitCompleted, type CodingFact,
} from './tasks.ts';
import { AT, cernerLine, doc, seedTask } from './testkit.ts';

const CODING = { mode: 'coder' as const, documentationGraceHours: 48, qaSamplePercent: 0 };
const DUE = addHours(AT, 48);
const task = (status: TaskStatus): CodingTask => ({ id: 'T1' as CodingTaskId, encounterId: 'E1' as never, status, origin: { kind: 'discharge', messageId: 'M0' as MessageId }, createdAt: AT, updatedAt: AT });
const document = doc('E1' as never, { id: 'D1' as never });
const radiology = doc('E1' as never, { id: 'D2' as never, kind: 'radiology_report' });
const FACTS: Record<CodingFact['kind'], CodingFact> = {
  final_document: { kind: 'final_document', document, correction: false },
  discharge: { kind: 'discharge', messageId: 'M1' as MessageId, dueAt: DUE },
  proposals: { kind: 'proposals', messageId: 'M2' as MessageId, appended: 2, dueAt: DUE },
};
const ALL = Object.keys(TASK_TRANSITIONS) as TaskStatus[];

// Decision 5 as a table: every (status x fact) cell, plus the no-task row.
const EXPECTED: Record<'none' | TaskStatus, Record<CodingFact['kind'], string>> = {
  none: { final_document: 'create ready_to_code', discharge: 'create awaiting_documentation', proposals: 'create awaiting_documentation' },
  awaiting_documentation: { final_document: '-> ready_to_code', discharge: 'none', proposals: 'none' },
  ready_to_code: { final_document: 'none', discharge: 'none', proposals: 'none' },
  in_progress: { final_document: 'none', discharge: 'none', proposals: 'none' },
  on_hold_query: { final_document: 'none', discharge: 'none', proposals: 'none' },
  returned_to_coder: { final_document: 'none', discharge: 'none', proposals: 'none' },
  coded: { final_document: '-> returned_to_coder', discharge: 'none', proposals: '-> returned_to_coder' },
  qa_review: { final_document: '-> returned_to_coder', discharge: 'none', proposals: '-> returned_to_coder' },
  released: { final_document: '-> in_progress', discharge: 'none', proposals: 'none' },
};
const describe = (r: ReturnType<typeof reactToFact>): string => (r.kind === 'create' ? `create ${r.status}` : r.kind === 'transition' ? `-> ${r.to}` : 'none');

for (const [status, row] of Object.entries(EXPECTED) as ['none' | TaskStatus, Record<CodingFact['kind'], string>][]) {
  test(`reactToFact(${status}) matches the decision-5 row`, () => {
    const current = status === 'none' ? undefined : task(status);
    for (const [kind, expected] of Object.entries(row) as [CodingFact['kind'], string][]) {
      const reaction = reactToFact(current, FACTS[kind]);
      assert.equal(describe(reaction), expected, `${status} x ${kind}`);
      if (kind === 'final_document') assert.equal(reaction.specialty, 'primary_care', 'specialty rides along on every document reaction');
      else assert.equal(reaction.specialty, undefined);
    }
  });
}

test('every status has a row, so the matrix is total', () => {
  assert.deepEqual(Object.keys(EXPECTED).filter((k) => k !== 'none').sort(), [...ALL].sort());
});

test('a corrected document reopens a released task; a new document after release reopens with its own reason', () => {
  assert.deepEqual(reactToFact(task('released'), { kind: 'final_document', document, correction: true }),
    { kind: 'transition', to: 'in_progress', reason: 'document corrected', specialty: 'primary_care' });
  assert.deepEqual(reactToFact(task('released'), { kind: 'final_document', document: radiology, correction: false }),
    { kind: 'transition', to: 'in_progress', reason: 'new document after release', specialty: 'radiology' });
  assert.deepEqual(reactToFact(task('released'), FACTS.proposals), { kind: 'none', reason: 'proposals pending after release; a person reopens' });
  const created = reactToFact(undefined, FACTS.discharge);
  assert.deepEqual(created, { kind: 'create', status: 'awaiting_documentation', origin: { kind: 'discharge', messageId: 'M1' }, reason: 'visit completed without documentation', documentationDueAt: DUE });
});

test('documentAppended raises a fact only for an appended final or corrected version', () => {
  const s = seedTask('awaiting_documentation');
  const encounter = s.store.getEncounter(s.encounterId)!;
  const prelim = appendDocumentVersion(s.store, s.encounterId, newId<MessageId>(), { externalId: 'RAD1', kind: 'radiology_report', status: 'preliminary', body: 'p' }, AT);
  assert.deepEqual(documentAppended(s.store, encounter, prelim, AT), []);
  assert.equal(s.store.getTask(s.task.id)!.status, 'awaiting_documentation');

  const final = appendDocumentVersion(s.store, s.encounterId, newId<MessageId>(), { externalId: 'RAD1', kind: 'radiology_report', status: 'final', body: 'f' }, AT);
  assert.equal(final.outcome, 'new_version');
  assert.deepEqual(documentAppended(s.store, encounter, final, AT), ['task ready_to_code']);
  const after = s.store.getTask(s.task.id)!;
  assert.equal(after.status, 'ready_to_code');
  assert.equal(after.specialty, 'radiology');
  assert.deepEqual(s.store.listTaskEvents(s.task.id).at(-1)!.reason, 'final document received');

  const unchanged = appendDocumentVersion(s.store, s.encounterId, newId<MessageId>(), { externalId: 'RAD1', kind: 'radiology_report', status: 'final', body: 'f' }, AT);
  assert.equal(unchanged.outcome, 'unchanged');
  assert.deepEqual(documentAppended(s.store, encounter, unchanged, AT), []);
  assert.equal(s.store.listTaskEvents(s.task.id).length, 2);
});

test('a reopen parks every open claim holding a live coder charge, and leaves released state out of claims that are not open', () => {
  const s = seedTask('released', { specialty: 'primary_care' });
  addCoderCharge(s);
  const claim = buildClaim(s.store, cfg, s.encounterId);
  assert.equal(claim.status, 'ready');
  const encounter = s.store.getEncounter(s.encounterId)!;
  const appended = appendDocumentVersion(s.store, s.encounterId, newId<MessageId>(), { externalId: 'DOC1', kind: 'progress_note', status: 'corrected', body: 'c' }, AT);
  assert.deepEqual(documentAppended(s.store, encounter, appended, AT), ['task in_progress']);
  assert.equal(s.store.getClaim(claim.id)!.status, 'draft');
  assert.deepEqual(s.store.listClaimEvents(claim.id).at(-1)!.reason, 'document corrected');
  assert.equal(s.store.getTask(s.task.id)!.specialty, 'primary_care', 'an existing specialty is kept');
});

test('reopenTask by a person moves released to in_progress with the actor and parks the claim; other statuses are refused', () => {
  const s = seedTask('released');
  addCoderCharge(s);
  const claim = buildClaim(s.store, cfg, s.encounterId);
  const reopened = reopenTask(s.store, s.task.id, 'denied for coding reason', 'lead-1');
  assert.equal(reopened.status, 'in_progress');
  assert.deepEqual(s.store.listTaskEvents(s.task.id).at(-1)!.actor, 'lead-1');
  assert.equal(s.store.getClaim(claim.id)!.status, 'draft');
  assert.throws(() => reopenTask(s.store, s.task.id, 'again'), InvalidTaskTransitionError);
});

test('cernerLinesArrived appends proposals and opens an awaiting task once; an identical redelivery raises no fact', () => {
  const s = seed();
  const encounter = s.store.getEncounter(s.encounterId)!;
  const ctx = { now: AT, messageId: newId<MessageId>() };
  const first = cernerLinesArrived(s.store, encounter, [cernerLine('T1')], ctx, CODING);
  assert.deepEqual(first.outcome, { appended: 2, unchanged: 0, unmatchedCredits: [] });
  assert.deepEqual(first.summary, ['2 proposals appended, 0 unchanged', 'task created awaiting_documentation']);
  const task = s.store.findTaskByEncounter(s.encounterId)!;
  assert.equal(task.documentationDueAt, addHours(encounter.dischargeAt!, 48), 'due counts from the stored discharge time');
  assert.deepEqual(task.origin, { kind: 'dft', messageId: ctx.messageId });

  const again = cernerLinesArrived(s.store, encounter, [cernerLine('T1')], { now: AT, messageId: newId<MessageId>() }, CODING);
  assert.deepEqual(again.outcome, { appended: 0, unchanged: 1, unmatchedCredits: [] });
  assert.deepEqual(again.summary, ['0 proposals appended, 1 unchanged']);
  assert.equal(s.store.listTaskEvents(task.id).length, 1);

  const credit = cernerLinesArrived(s.store, encounter, [cernerLine('T9', { reversal: true, procedure: { ...cernerLine('T9').procedure, code: '71046' } })], { now: AT, messageId: newId<MessageId>() }, CODING);
  assert.deepEqual(credit.summary, ['0 proposals appended, 0 unchanged', 'credits without a charge line: T9']);
  assert.equal(deriveCodeSet(s.store.listCodeAssignments(s.encounterId)).lines.length, 2);
});

test('proposals during QA return the task to the coder', () => {
  const s = seedTask('qa_review');
  const encounter = s.store.getEncounter(s.encounterId)!;
  const out = cernerLinesArrived(s.store, encounter, [cernerLine('T1')], { now: AT, messageId: newId<MessageId>() }, CODING);
  assert.deepEqual(out.summary.at(-1), 'task returned_to_coder');
  assert.equal(s.store.getTask(s.task.id)!.status, 'returned_to_coder');
});

test('visitCompleted opens an awaiting task from the discharge, and says so when one exists', () => {
  const s = seed();
  const encounter = s.store.getEncounter(s.encounterId)!;
  const ctx = { now: AT, messageId: newId<MessageId>() };
  assert.deepEqual(visitCompleted(s.store, encounter, ctx, CODING), ['task created awaiting_documentation']);
  const task = s.store.findTaskByEncounter(s.encounterId)!;
  assert.deepEqual([task.status, task.documentationDueAt, task.origin], ['awaiting_documentation', addHours(encounter.dischargeAt!, 48), { kind: 'discharge', messageId: ctx.messageId }]);
  assert.deepEqual(visitCompleted(s.store, encounter, ctx, CODING), ['task awaiting_documentation (task already awaiting documentation)']);
  const undischarged = { ...encounter, dischargeAt: undefined };
  const t = seed();
  visitCompleted(t.store, { ...undischarged, id: t.encounterId }, ctx, { ...CODING, documentationGraceHours: 2 });
  assert.equal(t.store.findTaskByEncounter(t.encounterId)!.documentationDueAt, addHours(AT, 2), 'without a discharge time the clock starts now');
});

test('assignTask writes the assignee; startTask self-assigns, refuses another coder, and is idempotent for the same coder', () => {
  const s = seedTask('ready_to_code');
  assert.equal(assignTask(s.store, s.task.id, 'lead-pick', AT).assignee, 'lead-pick');
  assert.equal(s.store.getTask(s.task.id)!.status, 'ready_to_code', 'assignment is not a status change');
  assert.throws(() => startTask(s.store, s.task.id, 'coder-2', AT), TaskAssignedElsewhereError);
  const started = startTask(s.store, s.task.id, 'lead-pick', AT);
  assert.deepEqual([started.status, started.assignee], ['in_progress', 'lead-pick']);
  assert.deepEqual(startTask(s.store, s.task.id, 'lead-pick', AT), s.store.getTask(s.task.id), 'a repeat start returns the task unchanged');
  assert.equal(s.store.listTaskEvents(s.task.id).length, 2);

  const pulled = seedTask('returned_to_coder');
  const out = startTask(pulled.store, pulled.task.id, 'coder-1', AT);
  assert.deepEqual([out.status, out.assignee, pulled.store.listTaskEvents(pulled.task.id).at(-1)!.actor], ['in_progress', 'coder-1', 'coder-1']);
  const waiting = seedTask('awaiting_documentation');
  assert.throws(() => startTask(waiting.store, waiting.task.id, 'coder-1', AT), InvalidTaskTransitionError);
  assert.equal(waiting.store.getTask(waiting.task.id)!.assignee, undefined, 'the refused start assigned nobody');
});

test('addHours is plain UTC arithmetic', () => {
  assert.equal(addHours('2026-11-08T10:15:00-08:00' as never, 48), '2026-11-10T18:15:00.000Z');
});
