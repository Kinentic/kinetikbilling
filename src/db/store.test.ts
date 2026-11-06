import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import { cents, type ClaimId, type Coverage, type CoverageId, type EncounterId, type IsoDate, type PatientId } from '../domain/types.ts';

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

test('charge identity is (encounter, FT1 transaction id) and amounts stay integer cents', () => {
  const store = new Store(':memory:');
  const pid = patient(store, '1');
  const eid = encounter(store, pid, 'FIN1');
  const id = newId<ChargeIdLocal>();
  const base = { id, encounterId: eid, externalId: 'T1', transactionType: 'CG' as const, serviceDate: '2026-11-01' as IsoDate, codeSystem: 'CPT' as const, code: '99213',
    modifiers: ['25'], units: 1, amount: cents(12550), diagnosisPointers: [1], status: 'unbilled' as const };
  store.saveCharge(base);
  store.saveCharge({ ...base, amount: cents(13000) });
  const found = store.findCharge(eid, 'T1')!;
  assert.equal(found.amount, 13000);
  assert.deepEqual(found.modifiers, ['25']);
  assert.equal(store.listCharges({ encounterId: eid, status: 'unbilled' }).length, 1);
});
type ChargeIdLocal = import('../domain/types.ts').ChargeId;
