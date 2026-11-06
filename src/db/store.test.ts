import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import {
  cents, type ChargeId, type ClaimId, type CodeAssignment, type CodeAssignmentId, type CodeContent, type CodeLineId, type CodingTask, type CodingTaskId, type Coverage,
  type CoverageId, type Document, type DocumentId, type EncounterId, type IsoDate, type IsoDateTime, type MessageId, type PatientId, type ProviderQueryId,
} from '../domain/types.ts';

const patient = (store: Store, mrn: string) => {
  const id = newId<PatientId>();
  store.savePatient({ id, mrn: { value: mrn, assigningAuthority: 'CERNER', typeCode: 'MR' }, lastName: 'Doe', firstName: 'Jane', sex: 'F', updatedAt: nowIso() });
  return id;
};
const encounter = (store: Store, patientId: PatientId, account: string) => {
  const id = newId<EncounterId>();
  store.saveEncounter({ id, patientId, accountNumber: account, facility: 'HOSP', patientClass: 'O', updatedAt: nowIso() });
  return id;
};
const coverage = (encounterId: EncounterId, priority: 1 | 2, payerId: string): Coverage => ({
  id: newId<CoverageId>(), encounterId, priority, payerId, payerName: payerId, memberId: 'M1', relationship: 'self',
  subscriber: { lastName: 'Doe', firstName: 'Jane' },
});

test('patient round-trips with optional fields absent, not null', () => {
  const store = new Store(':memory:');
  const id = patient(store, '100');
  const p = store.findPatientByMrn('100', 'CERNER');
  assert.deepEqual(p, { id, mrn: { value: '100', assigningAuthority: 'CERNER', typeCode: 'MR' }, lastName: 'Doe', firstName: 'Jane', sex: 'F', updatedAt: p!.updatedAt });
  assert.equal('dob' in p!, false);
});

test('replaceCoverages keeps the id of a priority a claim references', () => {
  const store = new Store(':memory:');
  const pid = patient(store, '1');
  const eid = encounter(store, pid, 'FIN1');
  const [primary] = store.replaceCoverages(eid, [coverage(eid, 1, 'AETNA'), coverage(eid, 2, 'MEDICARE')]);
  const now = nowIso();
  store.saveClaim({
    id: newId<ClaimId>(), encounterId: eid, patientId: pid, coverageId: primary!.id, type: 'professional', status: 'draft', controlNumber: 'C1',
    totalCharge: cents(0), totalPaid: cents(0), totalAdjusted: cents(0), patientResponsibility: cents(0), createdAt: now, updatedAt: now,
  });
  const again = store.replaceCoverages(eid, [{ ...coverage(eid, 1, 'AETNA'), memberId: 'M2' }]);
  assert.equal(again[0]!.id, primary!.id);
  assert.equal(store.getCoverage(primary!.id)!.memberId, 'M2');
  assert.deepEqual(store.listCoverages(eid).map((c) => c.priority), [1]);
});

test('mergePatients moves encounters to the survivor and marks the loser', () => {
  const store = new Store(':memory:');
  const a = patient(store, 'A');
  const b = patient(store, 'B');
  const eb = encounter(store, b, 'FIN-B');
  store.mergePatients(a, b, nowIso());
  assert.equal(store.getEncounter(eb)!.patientId, a);
  assert.equal(store.getPatient(b)!.mergedInto, a);
  assert.equal(store.listEncounters(a).length, 1);
});

test('transaction rolls back every write when the body throws', () => {
  const store = new Store(':memory:');
  assert.throws(() => store.transaction(() => { patient(store, 'X'); throw new Error('boom'); }), /boom/);
  assert.equal(store.findPatientByMrn('X', 'CERNER'), undefined);
});

const cernerCharge = (eid: EncounterId, externalId: string) => ({
  id: newId<ChargeId>(), encounterId: eid, source: 'cerner_dft' as const, externalId, transactionType: 'CG' as const, serviceDate: '2026-11-01' as IsoDate,
  codeSystem: 'CPT' as const, code: '99213', modifiers: ['25'], units: 1, amount: cents(12550), diagnoses: [{ sequence: 1, code: 'E11.9', codingSystem: 'ICD10' as const }],
});
const assignment = (eid: EncounterId, content: CodeContent, extra: Partial<CodeAssignment> = {}): CodeAssignment => {
  const row: CodeAssignment = {
    id: newId<CodeAssignmentId>(), encounterId: eid, lineId: newId<CodeLineId>(), content, removed: false, provenance: 'coder', recordedAt: nowIso(),
    decision: { by: 'coder-1', at: nowIso() }, ...extra,
  };
  if (row.decision === undefined) delete row.decision;
  return row;
};
const procedure: CodeContent = { kind: 'procedure', codeSystem: 'CPT', code: '99213', modifiers: ['25'], units: 1, serviceDate: '2026-11-01' as IsoDate, diagnosisCodes: ['E11.9'] };
/** A coder charge needs its code-log row first: charges.code_assignment_id references code_assignments. */
const coderCharge = (store: Store, eid: EncounterId) => {
  const row = assignment(eid, procedure);
  store.appendCodeAssignments([row]);
  return { ...cernerCharge(eid, `${row.id}#1`), source: 'coder' as const, codeAssignmentId: row.id };
};
const claim = (store: Store, eid: EncounterId, pid: PatientId, coverageId: CoverageId, controlNumber: string): ClaimId => {
  const id = newId<ClaimId>();
  const now = nowIso();
  store.saveClaim({
    id, encounterId: eid, patientId: pid, coverageId, type: 'professional', status: 'draft', controlNumber,
    totalCharge: cents(0), totalPaid: cents(0), totalAdjusted: cents(0), patientResponsibility: cents(0), createdAt: now, updatedAt: now,
  });
  return id;
};

test('a Cerner charge is keyed on (encounter, FT1 transaction id), updates in place, and reads back with a derived status', () => {
  const store = new Store(':memory:');
  const eid = encounter(store, patient(store, '1'), 'FIN1');
  const base = cernerCharge(eid, 'T1');
  store.saveCernerCharge(base);
  store.saveCernerCharge({ ...base, amount: cents(13000) });
  const found = store.findCernerCharge(eid, 'T1')!;
  assert.equal(found.amount, 13000);
  assert.deepEqual(found.modifiers, ['25']);
  assert.equal('status' in found, false);
  assert.deepEqual(store.listCharges({ encounterId: eid, status: 'unbilled' }).map((c) => [c.source, c.status, c.claimIds]), [['cerner_dft', 'unbilled', []]]);
  assert.deepEqual(store.listCharges({ source: 'coder' }), []);
});

test('attachCharges twice leaves one link; the charge reads as claimed with that claim id', () => {
  const store = new Store(':memory:');
  const pid = patient(store, '1');
  const eid = encounter(store, pid, 'FIN1');
  const [cov] = store.replaceCoverages(eid, [coverage(eid, 1, 'AETNA')]);
  const c = cernerCharge(eid, 'T1');
  store.saveCernerCharge(c);
  const claimId = claim(store, eid, pid, cov!.id, 'C1');
  store.attachCharges(claimId, [c.id], nowIso());
  store.attachCharges(claimId, [c.id], nowIso());
  assert.deepEqual(store.listCharges({ claimId }).map((x) => [x.id, x.status, x.claimIds]), [[c.id, 'claimed', [claimId]]]);
  assert.equal(store.listCharges({ status: 'claimed' }).length, 1);
});

test('listBillableCharges skips voided charges and charges already on a claim for that coverage, but not charges on another coverage', () => {
  const store = new Store(':memory:');
  const pid = patient(store, '1');
  const eid = encounter(store, pid, 'FIN1');
  const [primary, secondary] = store.replaceCoverages(eid, [coverage(eid, 1, 'AETNA'), coverage(eid, 2, 'MEDICARE')]);
  const open = cernerCharge(eid, 'T1');
  const onPrimary = cernerCharge(eid, 'T2');
  const voided = coderCharge(store, eid);
  store.saveCernerCharge(open);
  store.saveCernerCharge(onPrimary);
  store.insertCoderCharges([voided]);
  store.attachCharges(claim(store, eid, pid, primary!.id, 'C1'), [onPrimary.id], nowIso());
  store.voidCharges([voided.id], nowIso());
  assert.deepEqual(store.listBillableCharges(eid, primary!.id).map((c) => c.id), [open.id]);
  assert.deepEqual(store.listBillableCharges(eid, secondary!.id).map((c) => c.id).sort(), [open.id, onPrimary.id].sort());
});

test('voidCharges sets voided_at once and repeating it changes nothing', () => {
  const store = new Store(':memory:');
  const eid = encounter(store, patient(store, '1'), 'FIN1');
  const c = coderCharge(store, eid);
  store.insertCoderCharges([c]);
  const first = '2026-11-05T10:00:00.000Z' as IsoDateTime;
  store.voidCharges([c.id], first);
  store.voidCharges([c.id], '2026-11-06T10:00:00.000Z' as IsoDateTime);
  const state = store.getCharge(c.id)!;
  assert.equal(state.status, 'voided');
  assert.equal(state.source === 'coder' && state.voidedAt, first);
  const cerner = cernerCharge(eid, 'T1');
  store.saveCernerCharge(cerner);
  assert.throws(() => store.voidCharges([cerner.id], first), /constraint/i, 'a Cerner charge is not voidable');
});

const document = (eid: EncounterId, externalId: string, version: number, extra: Partial<Document> = {}): Document => ({
  id: newId<DocumentId>(), encounterId: eid, messageId: newId<MessageId>(), externalId, version, kind: 'progress_note', status: 'final', body: `v${version}`,
  recordedAt: nowIso(), ...extra,
});

test('documents: versions are appended, listed newest first per document, and never updated or re-appended at the same version', () => {
  const store = new Store(':memory:');
  const eid = encounter(store, patient(store, '1'), 'FIN1');
  store.appendDocument(document(eid, 'DOC1', 1, { status: 'preliminary', signedAt: '2026-11-01T10:00:00Z' as IsoDateTime }));
  store.appendDocument(document(eid, 'DOC1', 2, { signedAt: '2026-11-02T10:00:00Z' as IsoDateTime }));
  store.appendDocument(document(eid, 'RAD1', 1, { kind: 'radiology_report', signedAt: '2026-11-03T10:00:00Z' as IsoDateTime }));
  assert.deepEqual(store.listDocuments(eid).map((d) => [d.externalId, d.version]), [['RAD1', 1], ['DOC1', 2], ['DOC1', 1]]);
  assert.equal(store.latestDocumentVersion(eid, 'DOC1')!.body, 'v2');
  assert.equal(store.latestDocumentVersion(eid, 'NOPE'), undefined);
  assert.equal(store.hasFinalDocument(eid), true);
  assert.throws(() => store.appendDocument(document(eid, 'DOC1', 2)), /UNIQUE/, 'a version number is taken once');
  const other = encounter(store, patient(store, '2'), 'FIN2');
  store.appendDocument(document(other, 'DOC9', 1, { status: 'preliminary' }));
  assert.equal(store.hasFinalDocument(other), false);
  const stored = store.getDocument(store.listDocuments(eid)[0]!.id)!;
  assert.equal('title' in stored, false, 'absent optional fields stay absent');
});

const task = (eid: EncounterId, status: CodingTask['status'] = 'awaiting_documentation', extra: Partial<CodingTask> = {}): CodingTask => {
  const now = nowIso();
  return { id: newId<CodingTaskId>(), encounterId: eid, status, origin: { kind: 'discharge', messageId: newId<MessageId>() }, createdAt: now, updatedAt: now, ...extra };
};

test('tasks: insertTask writes the task with its first event, one task per encounter, and recordTaskTransition writes status and event together', () => {
  const store = new Store(':memory:');
  const eid = encounter(store, patient(store, '1'), 'FIN1');
  const t = task(eid, 'awaiting_documentation', { documentationDueAt: '2026-11-10T18:15:00.000Z' as IsoDateTime });
  store.insertTask(t, { taskId: t.id, at: t.createdAt, from: null, to: t.status, reason: 'visit completed' });
  assert.deepEqual(store.findTaskByEncounter(eid), t);
  assert.throws(() => store.insertTask(task(eid), { taskId: t.id, at: t.createdAt, from: null, to: 'ready_to_code', reason: 'x' }), /UNIQUE/);
  assert.equal(store.listTaskEvents(t.id).length, 1, 'the refused insert left no event behind');

  const at = '2026-11-09T09:00:00.000Z' as IsoDateTime;
  store.recordTaskTransition(t.id, 'ready_to_code', { taskId: t.id, at, from: 'awaiting_documentation', to: 'ready_to_code', reason: 'final document', detail: { documentId: 'D1' } });
  const after = store.getTask(t.id)!;
  assert.equal(after.status, 'ready_to_code');
  assert.equal(after.updatedAt, at);
  assert.deepEqual(store.listTaskEvents(t.id).map((e) => [e.from, e.to, e.reason, e.detail]), [[null, 'awaiting_documentation', 'visit completed', undefined], ['awaiting_documentation', 'ready_to_code', 'final document', { documentId: 'D1' }]]);

  store.setTaskAssignee(t.id, 'coder-1', at);
  store.setTaskSpecialty(t.id, 'radiology', at);
  assert.deepEqual([store.getTask(t.id)!.assignee, store.getTask(t.id)!.specialty], ['coder-1', 'radiology']);
});

test('listTasks filters by status, assignee, specialty, and the overdue instant', () => {
  const store = new Store(':memory:');
  const pid = patient(store, '1');
  const due = (h: number) => `2026-11-10T${String(h).padStart(2, '0')}:00:00.000Z` as IsoDateTime;
  const a = task(encounter(store, pid, 'A'), 'awaiting_documentation', { documentationDueAt: due(10) });
  const b = task(encounter(store, pid, 'B'), 'awaiting_documentation', { documentationDueAt: due(20) });
  const c = task(encounter(store, pid, 'C'), 'ready_to_code', { documentationDueAt: due(10), assignee: 'coder-1', specialty: 'radiology' });
  for (const t of [a, b, c]) store.insertTask(t, { taskId: t.id, at: t.createdAt, from: null, to: t.status, reason: 'seed' });
  assert.deepEqual(store.listTasks({ status: 'awaiting_documentation' }).map((t) => t.id), [a.id, b.id]);
  assert.deepEqual(store.listTasks({ documentationOverdueAt: due(12) }).map((t) => t.id), [a.id], 'c is past due but no longer awaiting');
  assert.deepEqual(store.listTasks({ documentationOverdueAt: due(9) }), []);
  assert.deepEqual(store.listTasks({ assignee: 'coder-1' }).map((t) => t.id), [c.id]);
  assert.deepEqual(store.listTasks({ specialty: 'radiology' }).map((t) => t.id), [c.id]);
  assert.equal(store.listTasks().length, 3);
});

test('code log: rows read back in log order with decision and sourceRef shape, and the append-only triggers and UNIQUE(supersedes) hold', () => {
  const store = new Store(':memory:');
  const eid = encounter(store, patient(store, '1'), 'FIN1');
  const proposal = assignment(eid, procedure, { provenance: 'cerner_dft', sourceRef: 'T0001', decision: undefined });
  const accepted = assignment(eid, procedure, { lineId: proposal.lineId, supersedes: proposal.id, provenance: 'cerner_dft', sourceRef: 'T0001' });
  const dx = assignment(eid, { kind: 'diagnosis', code: 'E11.9', sequence: 1 }, { decision: { by: 'coder-1', at: nowIso(), queryId: 'Q1' as ProviderQueryId } });
  assert.throws(() => store.appendCodeAssignments([dx]), /FOREIGN KEY/, 'a decision names a stored query');
  delete dx.decision!.queryId;
  store.appendCodeAssignments([proposal, accepted, dx]);
  const rows = store.listCodeAssignments(eid);
  assert.deepEqual(rows, [proposal, accepted, dx]);
  assert.equal('decision' in rows[0]!, false);
  assert.throws(() => store.appendCodeAssignments([assignment(eid, procedure, { lineId: proposal.lineId, supersedes: proposal.id })]), /UNIQUE/, 'no forks');
  assert.throws(() => store.appendCodeAssignments([assignment(eid, procedure, { sourceRef: 'T9' })]), /CHECK/, 'sourceRef is Cerner-only');
});

test('provider queries: answerQuery sets the answer once', () => {
  const store = new Store(':memory:');
  const eid = encounter(store, patient(store, '1'), 'FIN1');
  const t = task(eid);
  store.insertTask(t, { taskId: t.id, at: t.createdAt, from: null, to: t.status, reason: 'seed' });
  const q = { id: newId<ProviderQueryId>(), taskId: t.id, question: 'Total time?', raisedBy: 'coder-1', channel: 'in_app' as const, sentAt: nowIso() };
  store.insertQuery(q);
  assert.deepEqual(store.getQuery(q.id), q);
  const at = nowIso();
  store.answerQuery(q.id, '22 minutes', at);
  store.answerQuery(q.id, '35 minutes', nowIso());
  assert.deepEqual(store.listQueries(t.id).map((x) => x.answer), [{ text: '22 minutes', at }]);
});

test('fee schedule: replaceFeeSchedule swaps the whole set and modifiers round-trip sorted', () => {
  const store = new Store(':memory:');
  const from = '2026-01-01' as IsoDate;
  store.replaceFeeSchedule([{ code: '99213', modifiers: ['95', '25'], amount: cents(13000), effectiveFrom: from }, { code: '99213', modifiers: [], amount: cents(12500), effectiveFrom: from, effectiveTo: '2027-01-01' as IsoDate }]);
  assert.deepEqual(store.listFeeSchedule(), [
    { code: '99213', modifiers: [], amount: 12500, effectiveFrom: from, effectiveTo: '2027-01-01' },
    { code: '99213', modifiers: ['25', '95'], amount: 13000, effectiveFrom: from },
  ]);
  store.replaceFeeSchedule([{ code: '36415', modifiers: [], amount: cents(1700), effectiveFrom: from }]);
  assert.deepEqual(store.listFeeSchedule().map((l) => l.code), ['36415']);
});
