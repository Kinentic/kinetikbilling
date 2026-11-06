import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markSubmitted } from '../claims/index.ts';
import { cfg } from '../claims/testkit.ts';
import { cents, type CodeContent, type DiagnosisCode, type FeeScheduleLine, type IsoDate, type ProcedureCode, type ReleaseRecord } from '../domain/types.ts';
import { replaceFeeSchedule } from './fees.ts';
import { release, reviewQa, type ReleaseOutcome } from './release.ts';
import { InvalidTaskTransitionError } from './state.ts';
import { reopenTask, startTask } from './tasks.ts';
import { AT, doc, seedTask, type SeededTask } from './testkit.ts';
import { editCodes, readCodes } from './workbench.ts';

const DEPS = { billing: cfg, qaSamplePercent: 0 };
const QA = { billing: cfg, qaSamplePercent: 100 };
const fee = (code: string, amount: number): FeeScheduleLine => ({ code, modifiers: [], amount: cents(amount), effectiveFrom: '2026-01-01' as IsoDate });
const FEES = [fee('99213', 12500), fee('99214', 18000), fee('36415', 1700)];
const procedure = (code: string, diagnosisCodes = ['R07.9']): ProcedureCode => ({ kind: 'procedure', codeSystem: 'CPT', code, modifiers: [], units: 1, serviceDate: '2026-10-02' as IsoDate, diagnosisCodes });
const dx = (code: string, sequence: number): DiagnosisCode => ({ kind: 'diagnosis', code, sequence });

/** An in_progress task with a final note (so the author renders), the fee schedule, and the given decided content. */
const coded = (codes: CodeContent[] = [procedure('99213'), dx('R07.9', 1)], fees = FEES, withDocument = true): SeededTask => {
  const s = seedTask('in_progress', { assignee: 'coder-1' });
  if (withDocument) s.store.appendDocument(doc(s.encounterId));
  replaceFeeSchedule(s.store, fees);
  editCodes(s.store, cfg, s.task.id, 'coder-1', codes.map((content) => ({ op: 'add' as const, content })), AT);
  return s;
};
const lineFor = (s: SeededTask, code: string) => readCodes(s.store, cfg, s.task.id).lines.find((l) => l.current.content.code === code)!;
const change = (s: SeededTask, code: string, content: CodeContent): void => {
  const line = lineFor(s, code);
  editCodes(s.store, cfg, s.task.id, 'coder-1', [{ op: 'change', lineId: line.lineId, basedOn: line.current.id, content }], AT);
};
const released = (out: ReleaseOutcome | { kind: 'returned' }): Extract<ReleaseOutcome, { kind: 'released' }> => {
  assert.equal(out.kind, 'released', JSON.stringify(out));
  return out as Extract<ReleaseOutcome, { kind: 'released' }>;
};
const blocked = (out: ReleaseOutcome | { kind: 'returned' }): { rule: string; severity: string; lineId?: string; chargeId?: string }[] => {
  assert.equal(out.kind, 'blocked', JSON.stringify(out));
  return (out as Extract<ReleaseOutcome, { kind: 'blocked' }>).violations;
};
const events = (s: SeededTask) => s.store.listTaskEvents(s.task.id).map((e) => e.to);
const charges = (s: SeededTask) => s.store.listCharges({ encounterId: s.encounterId });

test('release prices the decided set into coder charges, moves the task through coded to released in one transaction, and builds the claim', () => {
  const s = coded();
  const out = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  assert.equal(out.releaseNumber, 1);
  assert.deepEqual([out.charges.created.length, out.charges.voided, out.charges.kept], [1, [], []]);
  const [charge] = charges(s);
  assert.equal(charge!.source, 'coder');
  const assignmentId = lineFor(s, '99213').current.id;
  assert.deepEqual(
    [charge!.id, charge!.externalId, charge!.amount, charge!.diagnoses, charge!.performingProvider?.npi, charge!.status],
    [out.charges.created[0], `${assignmentId}#1`, 12500, [{ sequence: 1, code: 'R07.9', codingSystem: 'ICD10' }], '1234567893', 'claimed'],
    'the fee schedule prices it, the diagnoses travel by value, the note author renders',
  );
  assert.equal(out.claim.kind, 'built');
  const claim = out.claim.kind === 'built' ? out.claim.claim : undefined;
  assert.deepEqual([claim?.status, claim?.totalCharge], ['ready', 12500]);
  assert.equal(out.task.status, 'released');
  assert.deepEqual(events(s), ['in_progress', 'coded', 'released']);
  const record = s.store.listTaskEvents(s.task.id).at(-1)!.detail as ReleaseRecord;
  assert.deepEqual([record.releaseNumber, record.codeSet.map((r) => r.content.code).sort(), record.charges], [1, ['99213', 'R07.9'], out.charges]);
});

test('a missing fee on one of two lines blocks the whole release and writes nothing', () => {
  const s = coded([procedure('99213'), procedure('36415'), dx('R07.9', 1)], [fee('99213', 12500)]);
  assert.deepEqual(blocked(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT)).map((v) => [v.rule, v.lineId]), [['fee-on-file', lineFor(s, '36415').lineId]]);
  assert.deepEqual([charges(s), events(s), s.store.listClaims().length], [[], ['in_progress'], 0]);
});

test('warnings block until acknowledged; the acknowledgement rides on the coded event', () => {
  const s = coded([procedure('99213'), dx('R07.9', 1)], FEES, false);
  assert.deepEqual(blocked(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT)).map((v) => [v.rule, v.severity]), [['rendering-provider', 'warning']]);
  assert.deepEqual(events(s), ['in_progress']);
  released(release(s.store, DEPS, s.task.id, { coder: 'coder-1', warningsAcknowledged: 'billing provider renders' }, AT));
  const codedEvent = s.store.listTaskEvents(s.task.id).find((e) => e.to === 'coded')!;
  assert.deepEqual([codedEvent.actor, (codedEvent.detail as { acknowledgement: string }).acknowledgement], ['coder-1', 'billing provider renders']);
});

test('QA sampling at 100 parks the release in qa_review with no charges; a repeat call answers qa_review without events; a return goes back to the coder', () => {
  const s = coded();
  const first = release(s.store, QA, s.task.id, { coder: 'coder-1' }, AT);
  assert.equal(first.kind, 'qa_review');
  assert.deepEqual([charges(s), events(s)], [[], ['in_progress', 'coded', 'qa_review']]);
  assert.equal(release(s.store, QA, s.task.id, { coder: 'coder-1' }, AT).kind, 'qa_review');
  assert.deepEqual(events(s), ['in_progress', 'coded', 'qa_review'], 'the repeat wrote nothing');

  const back = reviewQa(s.store, QA, s.task.id, { outcome: 'return', reviewer: 'lead-1', notes: 'add I10' }, AT);
  assert.equal(back.kind, 'returned');
  const last = s.store.listTaskEvents(s.task.id).at(-1)!;
  assert.deepEqual([last.to, last.actor, last.detail], ['returned_to_coder', 'lead-1', { notes: 'add I10' }]);
  startTask(s.store, s.task.id, 'coder-1', AT);
  released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  assert.deepEqual(events(s), ['in_progress', 'coded', 'qa_review', 'returned_to_coder', 'in_progress', 'coded', 'released'], 'sampling at 0 releases directly');
});

test('QA agree re-runs the edits: a fee lost since coded blocks and leaves the task in qa_review; with the fee back it releases, records the notes and builds', () => {
  const s = coded();
  assert.equal(release(s.store, QA, s.task.id, { coder: 'coder-1' }, AT).kind, 'qa_review');
  replaceFeeSchedule(s.store, []);
  assert.deepEqual(blocked(reviewQa(s.store, QA, s.task.id, { outcome: 'agree', reviewer: 'lead-1' }, AT)).map((v) => v.rule), ['fee-on-file']);
  assert.deepEqual([s.store.getTask(s.task.id)!.status, charges(s)], ['qa_review', []]);

  replaceFeeSchedule(s.store, FEES);
  const out = released(reviewQa(s.store, QA, s.task.id, { outcome: 'agree', reviewer: 'lead-1', notes: 'looks right' }, AT));
  assert.deepEqual([out.releaseNumber, out.charges.created.length, out.claim.kind], [1, 1, 'built']);
  const last = s.store.listTaskEvents(s.task.id).at(-1)!;
  assert.deepEqual([last.to, last.actor, (last.detail as ReleaseRecord).qaNotes], ['released', 'lead-1', 'looks right']);
});

test('release and reviewQa refuse every other status', () => {
  const ready = seedTask('ready_to_code');
  assert.throws(() => release(ready.store, DEPS, ready.task.id, { coder: 'coder-1' }, AT), InvalidTaskTransitionError);
  const working = seedTask('in_progress');
  assert.throws(() => reviewQa(working.store, DEPS, working.task.id, { outcome: 'agree', reviewer: 'lead-1' }, AT), InvalidTaskTransitionError);
  assert.throws(() => release(working.store, DEPS, 'nope' as never, { coder: 'coder-1' }, AT), /not found/);
});

test('re-release after a reopen voids only the changed line, keeps the other, and rebuilds the same claim draft -> ready with the new total', () => {
  const s = coded([procedure('99213'), procedure('36415'), dx('R07.9', 1)]);
  const first = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  const claim = first.claim.kind === 'built' ? first.claim.claim : undefined;
  assert.deepEqual([first.charges.created.length, claim?.totalCharge], [2, 14200]);

  reopenTask(s.store, s.task.id, 'denied for coding reason', 'lead-1');
  assert.equal(s.store.getClaim(claim!.id)!.status, 'draft', 'the reopen parks the claim');
  const keptId = charges(s).find((c) => c.code === '36415')!.id;
  const oldId = charges(s).find((c) => c.code === '99213')!.id;
  change(s, '99213', procedure('99214'));

  const second = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  assert.deepEqual([second.releaseNumber, second.charges.created.length, second.charges.voided, second.charges.kept], [2, 1, [oldId], [keptId]]);
  const rebuilt = second.claim.kind === 'built' ? second.claim.claim : undefined;
  assert.deepEqual([rebuilt?.id, rebuilt?.status, rebuilt?.totalCharge], [claim!.id, 'ready', 19700]);
  assert.deepEqual(s.store.listClaimEvents(claim!.id).map((e) => e.to), ['draft', 'ready', 'draft', 'ready']);
  assert.deepEqual(charges(s).map((c) => [c.code, c.status, c.externalId.endsWith('#2')]).sort(), [['36415', 'claimed', false], ['99213', 'voided', false], ['99214', 'claimed', true]]);
  assert.deepEqual(events(s), ['in_progress', 'coded', 'released', 'in_progress', 'coded', 'released']);
});

test('a repeat release of a released task writes nothing to coding state and re-runs the claim hand-off', () => {
  const s = coded();
  const first = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  const again = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  assert.deepEqual([again.releaseNumber, again.charges], [1, { created: [], voided: [], kept: first.charges.created }]);
  assert.equal(again.claim.kind === 'built' && again.claim.claim.id, first.claim.kind === 'built' && first.claim.claim.id);
  assert.deepEqual(events(s), ['in_progress', 'coded', 'released']);
});

test('no coverage: the release stands with the claim not built; a repeat release builds it once coverage exists', () => {
  const s = coded();
  const coverage = s.store.listCoverages(s.encounterId);
  s.store.replaceCoverages(s.encounterId, []);
  const out = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1', warningsAcknowledged: 'coverage to follow' }, AT));
  assert.deepEqual([out.claim.kind, out.claim.kind === 'not_built' && out.claim.error], ['not_built', `encounter ${s.encounterId} has no coverage at priority 1`]);
  assert.deepEqual([s.store.getTask(s.task.id)!.status, charges(s).map((c) => c.status)], ['released', ['unbilled']]);

  s.store.replaceCoverages(s.encounterId, coverage);
  const retry = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  assert.deepEqual([retry.charges.kept, retry.claim.kind], [out.charges.created, 'built']);
  assert.equal(retry.claim.kind === 'built' && retry.claim.claim.status, 'ready');
  assert.deepEqual(charges(s).map((c) => c.status), ['claimed']);
});

test('billed-claim-locked: a change that would void a charge on a submitted claim is blocked', () => {
  const s = coded();
  const first = released(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT));
  const claim = first.claim.kind === 'built' ? first.claim.claim : undefined;
  markSubmitted(s.store, claim!.id, new Date(AT));
  reopenTask(s.store, s.task.id, 'payer asked for a corrected level');
  assert.equal(s.store.getClaim(claim!.id)!.status, 'submitted', 'a submitted claim is not parked');
  change(s, '99213', procedure('99214'));
  assert.deepEqual(blocked(release(s.store, DEPS, s.task.id, { coder: 'coder-1' }, AT)).map((v) => [v.rule, v.chargeId]), [['billed-claim-locked', first.charges.created[0]]]);
  assert.deepEqual(charges(s).map((c) => c.status), ['claimed']);
});
