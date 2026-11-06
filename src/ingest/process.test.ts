import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Store } from '../db/store.ts';
import type { IsoDateTime, MessageId, Patient } from '../domain/types.ts';
import { comp, firstSegment, parseHl7 } from '../hl7/index.ts';
import { deriveCodeSet } from '../coding/index.ts';
import { handlersFor, processMessage, type HandlerTable, type ProcessResult } from './index.ts';

const dir = new URL('../../fixtures/hl7/', import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), 'utf8');
const A04 = load('adt-a04-register.hl7');
const A08 = load('adt-a08-update.hl7');
const A03 = load('adt-a03-discharge.hl7');
const A40 = load('adt-a40-merge.hl7');
const DFT = load('dft-p03-charges.hl7');
const BAR = load('bar-p01-account.hl7');
const MDM_T02 = load('mdm-t02-progress-note.hl7');
const MDM_T08 = load('mdm-t08-corrected-note.hl7');
const ORU_PRELIM = load('oru-r01-radiology-preliminary.hl7');
const ORU_FINAL = load('oru-r01-radiology-final.hl7');
const NOW = '2026-11-05T22:30:00.000Z' as IsoDateTime;
/** v0.1 behaviour: FT1 lines are charges, documents are stored, no tasks. The existing DFT assertions hold under it. */
const PASS: HandlerTable = handlersFor({ mode: 'pass_through', documentationGraceHours: 48, qaSamplePercent: 0 });
const CODER: HandlerTable = handlersFor({ mode: 'coder', documentationGraceHours: 48, qaSamplePercent: 0 });

/** Swap MSH-10 so a fixture can be resent as a new message. */
const withControlId = (raw: string, id: string): string => raw.replace(/^(MSH(?:\|[^|\r]*){8}\|)[^|\r]*/, `$1${id}`);
const lines = (...segs: string[]): string => segs.map((s) => `${s}\r`).join('');

function ackOf(r: ProcessResult): { code: string; controlId: string; text: string } {
  const msa = firstSegment(parseHl7(r.ack), 'MSA');
  assert.ok(msa, 'ACK carries an MSA segment');
  return { code: comp(msa, 1), controlId: comp(msa, 2), text: comp(msa, 3) };
}

function send(store: Store, raw: string, handlers: HandlerTable = PASS): ProcessResult {
  const r = processMessage(store, raw, handlers, NOW);
  const controlId = comp(firstSegment(parseHl7(raw), 'MSH')!, 10);
  assert.equal(ackOf(r).controlId, controlId, 'MSA-2 echoes the original control id');
  return r;
}

const janeDoe = (store: Store): Patient => store.findPatientByMrn('1000001', 'HOSP')!;
const fin123 = (store: Store) => store.findEncounter('HOSP', 'FIN000123')!;

test('A04 registers patient, encounter, coverages, guarantor and diagnoses', () => {
  const store = new Store(':memory:');
  const r = send(store, A04);
  assert.equal(r.status, 'accepted');
  assert.equal(ackOf(r).code, 'AA');
  assert.match(r.summary!, /patient 1000001 upserted, encounter FIN000123 upserted, 2 coverages/);

  const p = janeDoe(store);
  assert.deepEqual(p.mrn, { value: '1000001', assigningAuthority: 'HOSP', typeCode: 'MR' });
  assert.equal(p.lastName, 'DOE');
  assert.equal(p.firstName, 'JANE');
  assert.equal(p.middleName, 'Q');
  assert.equal(p.dob, '1985-02-14');
  assert.equal(p.sex, 'F');
  assert.deepEqual(p.address, { line1: '123 MAPLE ST', city: 'PORTLAND', state: 'OR', zip: '97201' });
  assert.equal(p.phone, '5035550142');
  assert.equal(p.ssnLast4, '3456');
  assert.ok(!JSON.stringify(p).includes('900123456'), 'full SSN is not stored');

  const e = fin123(store);
  assert.equal(e.patientId, p.id);
  assert.equal(e.facility, 'HOSP');
  assert.equal(e.patientClass, 'I');
  assert.equal(e.location, '3W-312-A');
  assert.equal(e.hospitalService, 'MED');
  assert.equal(e.visitNumber, 'FIN000123');
  assert.equal(e.admitAt, '2026-11-05T14:00:00-08:00');
  assert.equal(e.dischargeAt, undefined);
  assert.deepEqual(e.attendingProvider, { npi: '1234567893', lastName: 'SMITH', firstName: 'ROBERT', middleName: 'A' });

  const cov = store.listCoverages(e.id);
  assert.deepEqual(cov.map((c) => [c.priority, c.payerId, c.payerName, c.memberId, c.groupNumber, c.relationship]), [
    [1, 'BCBSOR', 'BLUE CROSS OF OREGON', 'XYZ123456789', 'GRP778', 'self'],
    [2, 'AETNA', 'AETNA SUPPLEMENT', 'AET998877', 'GRP990', 'self'],
  ]);
  assert.equal(cov[0]!.planId, 'PPO01');
  assert.equal(cov[0]!.effectiveFrom, '2026-01-01');
  assert.deepEqual(cov[0]!.subscriber, { lastName: 'DOE', firstName: 'JANE', middleName: 'Q', dob: '1985-02-14' });

  assert.deepEqual(store.getGuarantor(e.id), {
    encounterId: e.id, lastName: 'DOE', firstName: 'JANE', middleName: 'Q', relationship: 'self',
    address: { line1: '123 MAPLE ST', city: 'PORTLAND', state: 'OR', zip: '97201' }, phone: '5035550142',
  });
  assert.deepEqual(store.listDiagnoses(e.id).map((d) => [d.sequence, d.code, d.codingSystem, d.type, d.description]), [
    [1, 'R07.9', 'ICD10', 'A', 'Chest pain, unspecified'],
    [2, 'I10', 'ICD10', 'A', 'Essential (primary) hypertension'],
  ]);
  assert.equal(store.getMessage(store.findMessage('HOSP', 'HOSP00000001')!.id)!.status, 'accepted');
});

test('A08 updates the address and secondary payer; a later A08 without PID-13 keeps the phone', () => {
  const store = new Store(':memory:');
  send(store, A04);
  assert.equal(send(store, A08).status, 'accepted');
  const p = janeDoe(store);
  assert.deepEqual(p.address, { line1: '77 CEDAR AVE', line2: 'APT 4', city: 'PORTLAND', state: 'OR', zip: '97209' });
  const cov = store.listCoverages(fin123(store).id);
  assert.deepEqual(cov.map((c) => [c.priority, c.payerId, c.memberId]), [[1, 'BCBSOR', 'XYZ123456789'], [2, 'UHC', 'UHC55120034']]);

  const noPhone = withControlId(A08, 'HOSP00000102').replace('|^PRN^PH^^1^503^5550142|||M|', '||||M|');
  assert.equal(comp(firstSegment(parseHl7(noPhone), 'PID')!, 13), '');
  assert.equal(send(store, noPhone).status, 'accepted');
  assert.equal(janeDoe(store).phone, '5035550142');
  assert.equal(janeDoe(store).id, p.id);
  assert.equal(store.listPatients().length, 1);
});

test('A03 sets dischargeAt, and a later message without PV1-45 does not clear it', () => {
  const store = new Store(':memory:');
  send(store, A04);
  assert.equal(send(store, A03).status, 'accepted');
  assert.equal(fin123(store).dischargeAt, '2026-11-08T10:15:00-08:00');
  send(store, A08);
  assert.equal(fin123(store).dischargeAt, '2026-11-08T10:15:00-08:00');
});

test('A03 with an empty PV1-45 falls back to EVN-6, then EVN-2', () => {
  const store = new Store(':memory:');
  const noPv145 = A03.replace('|20261105140000-0800|20261108101500-0800\r', '|20261105140000-0800|\r')
    .replace('EVN|A03|20261108101500-0800', 'EVN|A03|20261108101400-0800');
  assert.equal(comp(firstSegment(parseHl7(noPv145), 'PV1')!, 45), '');
  assert.equal(send(store, withControlId(noPv145, 'D1')).status, 'accepted');
  assert.equal(fin123(store).dischargeAt, '2026-11-08T10:14:00-08:00', 'EVN-2');
  const withEvn6 = noPv145.replace('EVN|A03|20261108101400-0800', 'EVN|A03|20261108101400-0800||||20261108093000-0800');
  send(store, withControlId(withEvn6, 'D2'));
  assert.equal(fin123(store).dischargeAt, '2026-11-08T09:30:00-08:00', 'EVN-6');
});

test('BAR^P01 upserts the same account through the shared demographics handler', () => {
  const store = new Store(':memory:');
  assert.equal(PASS['BAR^P01'], PASS['ADT^A04']);
  assert.equal(send(store, BAR).status, 'accepted');
  assert.equal(store.listCoverages(fin123(store).id).length, 1);
});

test('DFT creates charges with codes, modifiers, signed amounts and diagnosis pointers', () => {
  const store = new Store(':memory:');
  send(store, A04);
  const r = send(store, DFT);
  assert.equal(r.status, 'accepted', r.error);
  assert.match(r.summary!, /3 charges \(3 new, 0 updated\)/);
  const e = fin123(store);
  const charges = store.listCharges({ encounterId: e.id });
  const byId = new Map(charges.map((c) => [c.externalId, c]));
  assert.equal(charges.length, 3);

  const visit = byId.get('T0001')!;
  assert.equal(visit.code, '99213');
  assert.equal(visit.codeSystem, 'CPT');
  assert.deepEqual(visit.modifiers, ['25', '95']);
  assert.equal(visit.amount, 12500);
  assert.equal(visit.transactionType, 'CG');
  assert.equal(visit.serviceDate, '2026-11-05');
  assert.equal(visit.description, 'OFFICE VISIT EST LOW');
  assert.equal(visit.department, 'MED');
  assert.equal(visit.status, 'unbilled');
  assert.equal(visit.performingProvider!.npi, '1234567893');
  assert.equal(visit.revenueCode, undefined);

  const venipuncture = byId.get('T0002')!;
  assert.equal(venipuncture.code, '36415');
  assert.equal(venipuncture.amount, 1700);
  assert.deepEqual(venipuncture.modifiers, []);
  const credit = byId.get('T0003')!;
  assert.equal(credit.transactionType, 'CD');
  assert.equal(credit.amount, -1700);

  assert.equal(visit.source, 'cerner_dft');
  const r079 = store.listDiagnoses(e.id).find((d) => d.code === 'R07.9')!;
  for (const c of charges) assert.deepEqual(c.diagnoses, [{ sequence: r079.sequence, code: 'R07.9', codingSystem: 'ICD10', description: 'Chest pain, unspecified' }]);
  assert.equal(store.listDiagnoses(e.id).length, 2, 'R07.9 was already on the encounter');
});

test('DFT redelivered with a changed FT1-11 updates the amount in place', () => {
  const store = new Store(':memory:');
  send(store, DFT);
  const before = store.listCharges().find((c) => c.externalId === 'T0001')!;
  const changed = withControlId(DFT, 'HOSP00000105').replace('|1|125.00|125.00|', '|1|130.00|130.00|');
  const r = send(store, changed);
  assert.match(r.summary!, /0 new, 3 updated/);
  const after = store.listCharges().filter((c) => c.externalId === 'T0001');
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, before.id);
  assert.equal(after[0]!.amount, 13000);
  assert.equal(store.listCharges().length, 3);
});

test('DFT on its own creates the patient and encounter, and FT1-19 codes missing from DG1 are appended', () => {
  const store = new Store(':memory:');
  const dft = DFT.replace('|IN|R07.9^Chest pain, unspecified^I10|1234567893', '|IN|R07.9^Chest pain, unspecified^I10~Z00.00^Exam^I10|1234567893');
  assert.equal(send(store, dft).status, 'accepted');
  const e = fin123(store);
  assert.deepEqual(store.listDiagnoses(e.id).map((d) => [d.sequence, d.code, d.type]), [[1, 'R07.9', 'F'], [2, 'Z00.00', 'F']]);
  const byId = new Map(store.listCharges().map((c) => [c.externalId, c]));
  assert.deepEqual(byId.get('T0001')!.diagnoses.map((d) => [d.sequence, d.code]), [[1, 'R07.9'], [2, 'Z00.00']]);
  assert.deepEqual(byId.get('T0002')!.diagnoses.map((d) => [d.sequence, d.code]), [[1, 'R07.9']]);
});

test('a DG1 after an FT1 joins the encounter list before pointers resolve', () => {
  const store = new Store(':memory:');
  const dft = DFT.replace('|IN|R07.9^Chest pain, unspecified^I10|1234567893', '|IN|I10^HTN^I10|1234567893')
    + 'DG1|1||I10^Essential (primary) hypertension^I10||20261105|A\r';
  assert.equal(send(store, dft).status, 'accepted');
  const dx = store.listDiagnoses(fin123(store).id);
  assert.deepEqual(dx.map((d) => [d.sequence, d.code, d.type]), [[1, 'I10', 'A'], [2, 'R07.9', 'F']]);
  const r079 = store.listCharges().find((c) => c.externalId === 'T0002')!;
  assert.deepEqual(r079.diagnoses.map((d) => [d.sequence, d.code]), [[2, 'R07.9']], 'R07.9 appended after I10');
  assert.deepEqual(store.listCharges().find((c) => c.externalId === 'T0001')!.diagnoses.map((d) => [d.sequence, d.code]), [[1, 'I10']]);
});

test('FT1 lines that are not CG or CD are skipped and counted', () => {
  const store = new Store(':memory:');
  const dft = DFT.replace('FT1|3|T0003|B20261105|20261105103000-0800|20261105170000-0800|CD|', 'FT1|3|T0003|B20261105|20261105103000-0800|20261105170000-0800|PY|');
  const r = send(store, dft);
  assert.match(r.summary!, /2 charges .*1 FT1 skipped/);
  assert.equal(store.listCharges().length, 2);
});

test('A40 moves the prior patient\'s encounters to the survivor and marks the prior merged', () => {
  const store = new Store(':memory:');
  send(store, A04);
  const priorA04 = withControlId(A04, 'HOSP00000090').replaceAll('1000001^^^HOSP^MR', '1000099^^^HOSP^MR').replaceAll('FIN000123', 'FIN000099');
  send(store, priorA04);
  const prior = store.findPatientByMrn('1000099', 'HOSP')!;
  assert.equal(store.findEncounter('HOSP', 'FIN000099')!.patientId, prior.id);

  const r = send(store, A40);
  assert.equal(r.status, 'accepted');
  assert.match(r.summary!, /patient 1000099 merged into it/);
  const survivor = janeDoe(store);
  assert.equal(store.findEncounter('HOSP', 'FIN000099')!.patientId, survivor.id);
  assert.equal(store.getPatient(prior.id)!.mergedInto, survivor.id);
  assert.equal(store.listEncounters(survivor.id).length, 2);

  send(store, withControlId(priorA04, 'HOSP00000091'));
  assert.equal(store.findEncounter('HOSP', 'FIN000099')!.patientId, survivor.id, 'a late message under the prior MRN keeps the account on the survivor');
});

test('A40 whose prior MRN is unknown upserts the survivor and says so', () => {
  const store = new Store(':memory:');
  const r = send(store, A40);
  assert.equal(r.status, 'accepted');
  assert.match(r.summary!, /prior MRN 1000099 not on file/);
  assert.ok(janeDoe(store));
});

test('the same control id twice is acknowledged as a duplicate without a second write', () => {
  const store = new Store(':memory:');
  send(store, A04);
  const r = send(store, A04.replace('123 MAPLE ST', '9 ELM ST'));
  assert.equal(r.status, 'duplicate');
  assert.equal(ackOf(r).code, 'AA');
  assert.equal(janeDoe(store).address!.line1, '123 MAPLE ST');
  assert.equal(store.listMessages().length, 1);
  assert.equal(store.listMessages()[0]!.status, 'accepted');
});

test('an unsupported type is acknowledged, stored as unsupported, and touches no patient data', () => {
  const store = new Store(':memory:');
  const siu = lines('MSH|^~\\&|CERNER|HOSP|BILLING|KINETIK|20261105150000-0800||SIU^S12^SIU_S12|HOSP00000777|P|2.5.1',
    'SCH|APPT1||||||ROUTINE|||30^MIN', 'PID|1||1000001^^^HOSP^MR||DOE^JANE');
  const r = send(store, siu);
  assert.equal(r.status, 'unsupported');
  assert.deepEqual(ackOf(r), { code: 'AA', controlId: 'HOSP00000777', text: 'Unsupported message type SIU^S12; stored' });
  const m = store.findMessage('HOSP', 'HOSP00000777')!;
  assert.equal(m.status, 'unsupported');
  assert.equal(m.raw, siu);
  assert.equal(store.listPatients().length, 0);
  assert.equal(send(store, siu).status, 'duplicate');
});

test('garbage is rejected with AR and stored as an error, repeatedly, without a key collision', () => {
  const store = new Store(':memory:');
  for (const raw of ['hello world', '', 'MSH|^~\\&|CERNER|HOSP']) {
    const r = processMessage(store, raw, PASS, NOW);
    assert.equal(r.status, 'error');
    const ack = ackOf(r);
    assert.equal(ack.code, 'AR');
    assert.ok(ack.text.length > 0, 'MSA-3 carries the parse error');
  }
  const stored = store.listMessages('error');
  assert.equal(stored.length, 3);
  assert.deepEqual(stored.map((m) => m.raw).sort(), ['', 'MSH|^~\\&|CERNER|HOSP', 'hello world']);
  assert.ok(stored.every((m) => m.error));
  assert.equal(store.listPatients().length, 0);
});

test('a parse failure with a readable MSH echoes its control id in the AR', () => {
  const store = new Store(':memory:');
  const raw = lines('MSH|^~\\&|CERNER|HOSP|BILLING|KINETIK|20261105150000-0800||ADT^A04|HOSP00000888|P|2.5.1', 'bad segment');
  const r = processMessage(store, raw, PASS, NOW);
  assert.deepEqual([ackOf(r).code, ackOf(r).controlId], ['AR', 'HOSP00000888']);
  const m = store.findMessage('HOSP', 'HOSP00000888')!;
  assert.deepEqual([m.status, m.messageType, m.triggerEvent], ['error', 'ADT', 'A04']);
});

test('a DFT without an account number is rejected with AE, writes nothing, and its retry reprocesses', () => {
  const store = new Store(':memory:');
  const noAccount = DFT.replaceAll('FIN000123^^^HOSP^AN', '');
  const r = send(store, noAccount);
  assert.equal(r.status, 'error');
  assert.equal(ackOf(r).code, 'AE');
  assert.match(ackOf(r).text, /PID-18 and PV1-19/);
  assert.match(r.error!, /PID-18/);
  const m = store.findMessage('HOSP', 'HOSP00000005')!;
  assert.equal(m.status, 'error');
  assert.match(m.error!, /PID-18/);
  assert.equal(store.listCharges().length, 0);
  assert.equal(store.listPatients().length, 0, 'the patient upsert rolled back with the handler');

  const retry = send(store, DFT);
  assert.equal(retry.status, 'accepted');
  assert.equal(store.listCharges().length, 3);
  const after = store.findMessage('HOSP', 'HOSP00000005')!;
  assert.equal(after.id, m.id);
  assert.equal(after.status, 'accepted');
  assert.equal(after.error, undefined);
  assert.equal(store.listMessages().length, 1);
});

test('a message without an MRN is rejected with AE naming PID-3', () => {
  const store = new Store(':memory:');
  const r = send(store, withControlId(A04, 'X1').replace('1000001^^^HOSP^MR~900123456^^^USSSA^SS', ''));
  assert.equal(ackOf(r).code, 'AE');
  assert.match(ackOf(r).text, /PID-3/);
  assert.equal(store.findMessage('HOSP', 'X1')!.status, 'error');
});

// Coder mode: documents drive tasks, DFT lines become proposals, nothing is billed.

const taskOf = (store: Store) => store.findTaskByEncounter(fin123(store).id)!;
const codeSet = (store: Store) => deriveCodeSet(store.listCodeAssignments(fin123(store).id));

test('coder mode: a final MDM stores the document and opens a ready_to_code task with the note\'s specialty', () => {
  const store = new Store(':memory:');
  send(store, A04, CODER);
  const r = send(store, MDM_T02, CODER);
  assert.equal(r.status, 'accepted', r.error);
  assert.match(r.summary!, /document DOC0001 new, task created ready_to_code/);
  const e = fin123(store);
  const [doc] = store.listDocuments(e.id);
  assert.equal(store.listDocuments(e.id).length, 1);
  assert.equal(doc!.version, 1);
  assert.equal(doc!.kind, 'progress_note');
  assert.equal(doc!.status, 'final');
  assert.equal(doc!.title, 'Progress Note');
  assert.equal(doc!.author!.npi, '1234567893');
  assert.equal(doc!.signedAt, '2026-11-08T11:55:00-08:00');
  assert.equal(doc!.messageId, store.findMessage('HOSP', 'HOSP00000010')!.id);
  assert.match(doc!.body, /^Chief complaint: chest pain.*\nAssessment: .*\nPlan: .*22 minutes\.$/s);
  const task = taskOf(store);
  assert.equal(task.status, 'ready_to_code');
  assert.equal(task.specialty, 'primary_care');
  assert.deepEqual(task.origin, { kind: 'document', documentId: doc!.id });
  assert.deepEqual(store.listTaskEvents(task.id).map((ev) => [ev.from, ev.to]), [[null, 'ready_to_code']]);
  assert.equal(store.listCharges().length, 0);
});

test('coder mode: a preliminary ORU is stored and raises no task; the final after it is version 2 and opens the task', () => {
  const store = new Store(':memory:');
  send(store, A04, CODER);
  const prelim = send(store, ORU_PRELIM, CODER);
  assert.match(prelim.summary!, /document RAD5501 new$/);
  const e = fin123(store);
  assert.equal(store.findTaskByEncounter(e.id), undefined);
  assert.equal(store.latestDocumentVersion(e.id, 'RAD5501')!.status, 'preliminary');

  const final = send(store, ORU_FINAL, CODER);
  assert.match(final.summary!, /document RAD5501 new_version, task created ready_to_code/);
  const latest = store.latestDocumentVersion(e.id, 'RAD5501')!;
  assert.equal(latest.version, 2);
  assert.equal(latest.status, 'final');
  assert.equal(latest.kind, 'radiology_report');
  assert.equal(latest.author!.npi, '2222222226', 'OBX-16 responsible observer');
  assert.equal(latest.observedAt, '2026-11-05T14:30:00-08:00');
  assert.equal(latest.signedAt, '2026-11-05T16:55:00-08:00');
  assert.match(latest.body, /^FINDINGS: .*\nIMPRESSION: No acute cardiopulmonary process\.$/s);
  assert.equal(taskOf(store).specialty, 'radiology');

  assert.match(send(store, withControlId(ORU_PRELIM, 'HOSP00000029'), CODER).summary!, /document RAD5501 stale/);
  assert.equal(store.listDocuments(e.id).length, 2);
});

test('coder mode: the same MDM under a new MSH-10 is unchanged: no new version, no task event', () => {
  const store = new Store(':memory:');
  send(store, MDM_T02, CODER);
  const before = store.listTaskEvents(taskOf(store).id).length;
  const r = send(store, withControlId(MDM_T02, 'HOSP00000019'), CODER);
  assert.equal(r.status, 'accepted');
  assert.match(r.summary!, /document DOC0001 unchanged/);
  assert.doesNotMatch(r.summary!, /task/);
  assert.equal(store.listDocuments(fin123(store).id).length, 1);
  assert.equal(store.listTaskEvents(taskOf(store).id).length, before);
  assert.equal(send(store, MDM_T02, CODER).status, 'duplicate');
});

test('coder mode: a T08 versions the T02 document as corrected and reopens a released task', () => {
  const store = new Store(':memory:');
  send(store, MDM_T02, CODER);
  const e = fin123(store);
  const task = taskOf(store);
  // A released task is seeded through the Store: release itself is unit 3.
  store.recordTaskTransition(task.id, 'released', { taskId: task.id, at: NOW, from: 'ready_to_code', to: 'released', reason: 'seeded' });

  const r = send(store, MDM_T08, CODER);
  assert.equal(r.status, 'accepted', r.error);
  assert.match(r.summary!, /document DOC0001 new_version, task in_progress/);
  const versions = store.listDocuments(e.id);
  assert.deepEqual(versions.map((d) => [d.version, d.status]), [[2, 'corrected'], [1, 'final']]);
  assert.match(versions[0]!.body, /35 minutes/);
  assert.equal(taskOf(store).status, 'in_progress');
  assert.deepEqual(store.listTaskEvents(task.id).at(-1)!.reason, 'document corrected');

  const again = send(store, withControlId(MDM_T08, 'HOSP00000018'), CODER);
  assert.match(again.summary!, /document DOC0001 unchanged/);
  assert.equal(store.listDocuments(e.id).length, 2);
});

test('coder mode: a T08 before any T02 is version 1 and still opens one task', () => {
  const store = new Store(':memory:');
  assert.match(send(store, MDM_T08, CODER).summary!, /document DOC0001 new, task created ready_to_code/);
  assert.match(send(store, MDM_T02, CODER).summary!, /document DOC0001 new_version, task ready_to_code \(document visible/);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listDocuments(fin123(store).id).length, 2);
});

test('an MDM whose OBX is an ED attachment stores the payload and an empty body', () => {
  const store = new Store(':memory:');
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  const mdm = MDM_T02.split('\r').filter((l) => !l.startsWith('OBX')).join('\r') + `OBX|1|ED|PN^Progress Note^CERNERDOC||CERNER^application^pdf^Base64^${pdf}||||||F\r`;
  assert.equal(send(store, mdm, CODER).status, 'accepted');
  const [doc] = store.listDocuments(fin123(store).id);
  assert.equal(doc!.body, '');
  assert.deepEqual(doc!.attachment, { mediaType: 'application/pdf', base64: pdf });
});

test('an ORU with two OBRs stores two documents', () => {
  const store = new Store(':memory:');
  const second = ORU_FINAL.split('\r').filter((l) => l.startsWith('OBR') || l.startsWith('OBX')).join('\r')
    .replace('RAD5501^CERNER', 'RAD5502^CERNER').replace('71046^XR CHEST 2 VIEWS^CPT|', '73030^XR SHOULDER^CPT|') + '\r';
  const r = send(store, ORU_FINAL + second, CODER);
  assert.equal(r.status, 'accepted', r.error);
  assert.deepEqual(store.listDocuments(fin123(store).id).map((d) => d.externalId).sort(), ['RAD5501', 'RAD5502']);
  assert.equal(store.listTasks().length, 1);
});

test('an MDM without a TXA is rejected with AE and its retry reprocesses', () => {
  const store = new Store(':memory:');
  const noTxa = MDM_T02.split('\r').filter((l) => !l.startsWith('TXA')).join('\r') + '\r';
  const r = send(store, noTxa, CODER);
  assert.equal(ackOf(r).code, 'AE');
  assert.match(ackOf(r).text, /TXA/);
  assert.equal(store.listPatients().length, 0, 'the demographics rolled back with the handler');
  assert.equal(send(store, MDM_T02, CODER).status, 'accepted');
});

test('coder mode: a DFT writes no charge, appends proposals and opens an awaiting_documentation task; a redelivery appends nothing', () => {
  const store = new Store(':memory:');
  send(store, A04, CODER);
  const r = send(store, DFT, CODER);
  assert.equal(r.status, 'accepted', r.error);
  assert.match(r.summary!, /4 proposals appended, 0 unchanged, task created awaiting_documentation/);
  assert.equal(store.listCharges().length, 0);
  const task = taskOf(store);
  assert.equal(task.status, 'awaiting_documentation');
  assert.deepEqual(task.origin, { kind: 'dft', messageId: store.findMessage('HOSP', 'HOSP00000005')!.id });
  assert.equal(task.documentationDueAt, '2026-11-07T22:30:00.000Z', 'no discharge yet: now plus 48 hours');

  const lines = codeSet(store).lines;
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.pending && l.current.provenance === 'cerner_dft'));
  const visit = lines.find((l) => l.current.sourceRef === 'T0001')!;
  assert.deepEqual(visit.current.content, { kind: 'procedure', codeSystem: 'CPT', code: '99213', modifiers: ['25', '95'], units: 1, serviceDate: '2026-11-05',
    renderingProvider: { npi: '1234567893', lastName: 'SMITH', firstName: 'ROBERT', middleName: 'A' }, diagnosisCodes: ['R07.9'] });
  const venipuncture = lines.find((l) => l.history[0]!.sourceRef === 'T0002')!;
  assert.deepEqual(venipuncture.history.map((h) => [h.sourceRef, h.removed]), [['T0002', false], ['T0003', true]], 'the CD retracts its CG as a pending removal');
  const dx = lines.find((l) => l.current.content.kind === 'diagnosis')!;
  assert.deepEqual(dx.current.content, { kind: 'diagnosis', code: 'R07.9', sequence: 1, description: 'Chest pain, unspecified' });
  assert.equal(dx.current.sourceRef, 'dx:R07.9');

  const again = send(store, withControlId(DFT, 'HOSP00000105'), CODER);
  assert.match(again.summary!, /0 proposals appended, 3 unchanged/);
  assert.doesNotMatch(again.summary!, /task/);
  assert.equal(store.listCodeAssignments(fin123(store).id).length, 4);
  assert.equal(store.listTaskEvents(task.id).length, 1);
  assert.equal(store.listCharges().length, 0);
});

test('coder mode: an A03 opens an awaiting_documentation task due 48 hours after discharge; a later final document makes it ready', () => {
  const store = new Store(':memory:');
  send(store, A04, CODER);
  const r = send(store, A03, CODER);
  assert.match(r.summary!, /task created awaiting_documentation/);
  const task = taskOf(store);
  assert.equal(task.status, 'awaiting_documentation');
  assert.equal(task.documentationDueAt, '2026-11-10T18:15:00.000Z');
  assert.deepEqual(task.origin, { kind: 'discharge', messageId: store.findMessage('HOSP', 'HOSP00000003')!.id });
  assert.deepEqual(store.listTasks({ documentationOverdueAt: '2026-11-10T19:00:00.000Z' as IsoDateTime }).map((t) => t.id), [task.id]);
  assert.deepEqual(store.listTasks({ documentationOverdueAt: '2026-11-08T19:00:00.000Z' as IsoDateTime }), []);

  assert.match(send(store, withControlId(A03, 'HOSP00000033'), CODER).summary!, /task awaiting_documentation \(task already awaiting/);
  assert.match(send(store, MDM_T02, CODER).summary!, /task ready_to_code/);
  assert.equal(taskOf(store).specialty, 'primary_care');
  assert.deepEqual(store.listTaskEvents(task.id).map((ev) => ev.to), ['awaiting_documentation', 'ready_to_code']);
});

test('pass-through mode: documents are stored and no task exists', () => {
  const store = new Store(':memory:');
  send(store, A04);
  assert.match(send(store, MDM_T02).summary!, /document DOC0001 new$/);
  send(store, A03);
  send(store, DFT);
  assert.equal(store.listDocuments(fin123(store).id).length, 1);
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.listCharges().length, 3);
  assert.equal(store.listCodeAssignments(fin123(store).id).length, 0);
});

test('the handler receives the audit row id, and a retry of an error row keeps it', () => {
  const store = new Store(':memory:');
  const seen: MessageId[] = [];
  const table: HandlerTable = { 'ADT^A04': (_s, _m, ctx) => { seen.push(ctx.messageId); if (seen.length === 1) throw new Error('first try fails'); return { summary: 'ok' }; } };
  assert.equal(processMessage(store, A04, table, NOW).status, 'error');
  assert.equal(processMessage(store, A04, table, NOW).status, 'accepted');
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(store.getMessage(seen[0]!)!.status, 'accepted');
});
