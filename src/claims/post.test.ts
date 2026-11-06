import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, type Adjustment, type Remittance } from '../domain/types.ts';
import { buildClaim } from './build.ts';
import { parse835 } from './edi835.ts';
import { outstanding, postRemittance } from './post.ts';
import { ClaimNotFoundError, InvalidTransitionError } from './state.ts';
import { acknowledge, closeClaim, markSubmitted } from './submit.ts';
import { SAMPLE_835, addCharge, cfg, seed } from './testkit.ts';

const submittedClaim = (totalCents = 10000, accountNumber = 'FIN000123') => {
  const s = seed({ encounter: { accountNumber } });
  addCharge(s, { amount: cents(totalCents) });
  const claim = buildClaim(s.store, cfg, s.encounterId);
  markSubmitted(s.store, claim.id, new Date('2026-10-05T00:00:00Z'));
  return { ...s, claim };
};

const remit = (controlNumber: string, r: Partial<Remittance> & { adjustments?: Adjustment[] }): Remittance => ({
  controlNumber, statusCode: '1', chargedAmount: cents(10000), paidAmount: cents(0), patientResponsibility: cents(0), adjustments: [],
  payerClaimControlNumber: 'PCN1', checkNumber: 'CHK1', ...r,
});
const adj = (group: Adjustment['group'], reasonCode: string, amount: number): Adjustment => ({ group, reasonCode, amount: cents(amount) });

test('full payment moves the claim to paid and records the payment', () => {
  const { store, claim } = submittedClaim();
  const out = postRemittance(store, remit(claim.controlNumber, { paidAmount: cents(10000) }), '835');
  assert.equal(out.status, 'paid');
  assert.equal(out.totalPaid, 10000);
  assert.equal(out.payerClaimControlNumber, 'PCN1');
  assert.equal(store.getClaim(claim.id)!.status, 'paid');
  assert.equal(store.listPayments(claim.id).length, 1);
});

test('partial payment with a CO adjustment leaves the right balance outstanding', () => {
  const { store, claim } = submittedClaim();
  const out = postRemittance(store, remit(claim.controlNumber, { paidAmount: cents(6000), adjustments: [adj('CO', '45', 2000)] }), '835');
  assert.equal(out.status, 'partially_paid');
  assert.equal(out.totalAdjusted, 2000);
  assert.equal(outstanding(out), 2000);
});

test('patient responsibility counts once whether it arrives as PR CAS, CLP05, or both', () => {
  const both = submittedClaim(10000, 'FIN-A');
  const viaBoth = postRemittance(both.store, remit(both.claim.controlNumber, { paidAmount: cents(8000), patientResponsibility: cents(1500), adjustments: [adj('PR', '2', 1500), adj('CO', '45', 500)] }), '835');
  assert.equal(viaBoth.patientResponsibility, 1500);
  assert.equal(viaBoth.status, 'paid');

  const clp05 = submittedClaim(10000, 'FIN-B');
  const viaClp05 = postRemittance(clp05.store, remit(clp05.claim.controlNumber, { paidAmount: cents(9000), patientResponsibility: cents(1000) }), '835');
  assert.equal(viaClp05.patientResponsibility, 1000);
  assert.equal(viaClp05.status, 'paid');
});

test('a denial moves the claim to denied and keeps the adjustment', () => {
  const { store, claim } = submittedClaim();
  acknowledge(store, claim.id, true, { code: 'A2' });
  const out = postRemittance(store, remit(claim.controlNumber, { statusCode: '4', adjustments: [adj('CO', '29', 10000)] }), '835');
  assert.equal(out.status, 'denied');
  assert.equal(out.totalPaid, 0);
  assert.equal(out.totalAdjusted, 10000);
});

test('a reversal undoes the earlier posting and reopens the balance', () => {
  const { store, claim } = submittedClaim();
  postRemittance(store, remit(claim.controlNumber, { paidAmount: cents(9000), adjustments: [adj('CO', '45', 1000)] }), '835');
  const out = postRemittance(store, remit(claim.controlNumber, {
    statusCode: '22', chargedAmount: cents(-10000), paidAmount: cents(-9000), adjustments: [adj('CO', '45', -1000)], checkNumber: 'CHK2',
  }), '835');
  assert.equal(out.status, 'partially_paid');
  assert.equal(out.totalPaid, 0);
  assert.equal(out.totalAdjusted, 0);
  assert.equal(outstanding(out), 10000);
});

test('posting the same remittance twice is a no-op', () => {
  const { store, claim } = submittedClaim();
  const r = remit(claim.controlNumber, { paidAmount: cents(4000) });
  const first = postRemittance(store, r, '835');
  const events = store.listClaimEvents(claim.id).length;
  const second = postRemittance(store, r, '835');
  assert.deepEqual(second, first);
  assert.equal(store.listPayments(claim.id).length, 1);
  assert.equal(store.listClaimEvents(claim.id).length, events);
  assert.equal(second.totalPaid, 4000);
});

test('a remittance for an unknown control number throws ClaimNotFoundError', () => {
  const { store } = submittedClaim();
  assert.throws(() => postRemittance(store, remit('NOPE-1', {}), 'manual'), ClaimNotFoundError);
});

test('a remittance on a claim never submitted is refused and nothing is saved', () => {
  const s = seed();
  addCharge(s);
  const claim = buildClaim(s.store, cfg, s.encounterId);
  assert.throws(() => postRemittance(s.store, remit(claim.controlNumber, { paidAmount: cents(100) }), '835'), InvalidTransitionError);
  assert.deepEqual(s.store.listPayments(claim.id), []);
  assert.equal(s.store.getClaim(claim.id)!.totalPaid, 0);
});

test('a parsed 835 posts end to end, then the paid claim closes', () => {
  const { store, claim } = submittedClaim(15550);
  const [first] = parse835(SAMPLE_835);
  const out = postRemittance(store, first!, '835');
  assert.equal(out.totalPaid, 10000);
  assert.equal(out.totalAdjusted, 3050);
  assert.equal(out.patientResponsibility, 2500);
  assert.equal(outstanding(out), 0);
  assert.equal(out.status, 'paid');
  assert.equal(closeClaim(store, claim.id, 'zero balance').status, 'closed');
});
