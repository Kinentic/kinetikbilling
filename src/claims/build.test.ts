import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, type CoverageId, type ScrubViolation } from '../domain/types.ts';
import { newId, nowIso } from '../domain/ids.ts';
import { NoCoverageError, NoUnbilledChargesError, buildClaim, draftClaim, reworkClaim } from './build.ts';
import { acknowledge, markSubmitted } from './submit.ts';
import { InvalidTransitionError } from './state.ts';
import { addCharge, addCoderCharge, cfg, seed } from './testkit.ts';

test('buildClaim attaches unbilled charges, sums signed cents, and lands in ready', () => {
  const s = seed();
  const a = addCharge(s, { amount: cents(12550) });
  const b = addCharge(s, { code: '85025', amount: cents(4000) });
  const credit = addCharge(s, { code: '85025', transactionType: 'CD', amount: cents(-1000) });
  const claim = buildClaim(s.store, cfg, s.encounterId);

  assert.equal(claim.status, 'ready');
  assert.equal(claim.totalCharge, 15550);
  assert.equal(claim.controlNumber, 'FIN000123-1');
  assert.equal(claim.type, 'professional');
  assert.equal(claim.coverageId, s.coverage.id);
  for (const c of [a, b, credit]) {
    const stored = s.store.getCharge(c.id)!;
    assert.equal(stored.status, 'claimed');
    assert.deepEqual(stored.claimIds, [claim.id]);
  }
  assert.deepEqual(s.store.listClaimEvents(claim.id).map((e) => [e.from, e.to]), [[null, 'draft'], ['draft', 'ready']]);
});

test('a second buildClaim adds the new charge to the same claim', () => {
  const s = seed();
  addCharge(s, { amount: cents(10000) });
  const first = buildClaim(s.store, cfg, s.encounterId);
  const late = addCharge(s, { code: '36415', amount: cents(1500) });
  const second = buildClaim(s.store, cfg, s.encounterId);

  assert.equal(second.id, first.id);
  assert.equal(s.store.listClaims({ encounterId: s.encounterId }).length, 1);
  assert.equal(second.totalCharge, 11500);
  assert.equal(second.status, 'ready');
  assert.deepEqual(s.store.getCharge(late.id)!.claimIds, [first.id]);
  assert.deepEqual(s.store.listClaimEvents(first.id).map((e) => e.to), ['draft', 'ready', 'draft', 'ready']);
});

test('buildClaim with nothing new returns the open claim unchanged', () => {
  const s = seed();
  addCharge(s);
  const first = buildClaim(s.store, cfg, s.encounterId);
  const again = buildClaim(s.store, cfg, s.encounterId);
  assert.deepEqual(again, first);
  assert.equal(s.store.listClaimEvents(first.id).length, 2);
});

test('a submitted claim is not reopened; new charges start a second claim with the next control number', () => {
  const s = seed();
  addCharge(s);
  const first = buildClaim(s.store, cfg, s.encounterId);
  markSubmitted(s.store, first.id, new Date('2026-10-04T00:00:00Z'));
  addCharge(s, { code: '36415' });
  const second = buildClaim(s.store, cfg, s.encounterId);
  assert.notEqual(second.id, first.id);
  assert.equal(second.controlNumber, 'FIN000123-2');
});

test('control numbers stay within 20 characters for long account numbers', () => {
  const s = seed({ encounter: { accountNumber: 'ACCT-000000000000000000099' } });
  addCharge(s);
  const claim = buildClaim(s.store, cfg, s.encounterId);
  assert.ok(claim.controlNumber.length <= 20, claim.controlNumber);
  assert.match(claim.controlNumber, /-1$/);
});

test('buildClaim throws named errors for missing coverage priority or no charges', () => {
  const s = seed();
  assert.throws(() => buildClaim(s.store, cfg, s.encounterId), NoUnbilledChargesError);
  addCharge(s);
  assert.throws(() => buildClaim(s.store, cfg, s.encounterId, { coveragePriority: 2 }), NoCoverageError);
  assert.equal(s.store.listClaims({ encounterId: s.encounterId }).length, 0);
});

test('a scrub error lands the claim in scrub_failed with the violations as event detail', () => {
  const s = seed({ patient: { address: undefined } });
  addCharge(s);
  const claim = buildClaim(s.store, cfg, s.encounterId);
  assert.equal(claim.status, 'scrub_failed');
  const last = s.store.listClaimEvents(claim.id).at(-1)!;
  assert.ok((last.detail as ScrubViolation[]).some((v) => v.rule === 'patient-address' && v.severity === 'error'));
});

test('reworkClaim sends a rejected claim back through draft and rescrubs it', () => {
  const s = seed();
  addCharge(s);
  const claim = buildClaim(s.store, cfg, s.encounterId);
  markSubmitted(s.store, claim.id, new Date());
  acknowledge(s.store, claim.id, false, { code: 'A7' });
  const reworked = reworkClaim(s.store, cfg, claim.id);
  assert.equal(reworked.status, 'ready');
  assert.deepEqual(s.store.listClaimEvents(claim.id).slice(-3).map((e) => [e.from, e.to]), [['submitted', 'rejected'], ['rejected', 'draft'], ['draft', 'ready']]);
  assert.throws(() => reworkClaim(s.store, cfg, claim.id), InvalidTransitionError);
});

test('buildClaim rescrubs an open claim whose charge was voided, so the total drops', () => {
  const s = seed();
  const kept = addCoderCharge(s, { amount: cents(10000) });
  const voided = addCoderCharge(s, { code: '36415', amount: cents(1500) });
  const first = buildClaim(s.store, cfg, s.encounterId);
  assert.equal(first.totalCharge, 11500);
  s.store.voidCharges([voided.id], nowIso());
  const again = buildClaim(s.store, cfg, s.encounterId);
  assert.equal(again.id, first.id);
  assert.equal(again.totalCharge, 10000);
  assert.equal(again.status, 'ready');
  assert.equal(s.store.getCharge(voided.id)!.status, 'voided');
  assert.equal(s.store.getCharge(kept.id)!.status, 'claimed');
});

test('a charge on the primary claim is still billable to a secondary coverage', () => {
  const s = seed();
  s.store.replaceCoverages(s.encounterId, [s.coverage, { ...s.coverage, id: newId<CoverageId>(), priority: 2, payerId: '00123', payerName: 'Medicare', memberId: 'MBI1' }]);
  const charge = addCharge(s);
  const primary = buildClaim(s.store, cfg, s.encounterId);
  const secondary = buildClaim(s.store, cfg, s.encounterId, { coveragePriority: 2 });
  assert.notEqual(secondary.id, primary.id);
  assert.deepEqual(new Set(s.store.getCharge(charge.id)!.claimIds), new Set([primary.id, secondary.id]));
  assert.throws(() => buildClaim(s.store, cfg, s.encounterId, { coveragePriority: 3 }), NoCoverageError);
});

test('draftClaim parks a ready claim, is a no-op on a draft, and refuses a submitted claim', () => {
  const s = seed();
  addCharge(s);
  const ready = buildClaim(s.store, cfg, s.encounterId);
  const parked = draftClaim(s.store, ready.id, 'task reopened', { taskId: 'T1' });
  assert.equal(parked.status, 'draft');
  const again = draftClaim(s.store, ready.id, 'task reopened');
  assert.deepEqual(again, parked);
  const events = s.store.listClaimEvents(ready.id);
  assert.deepEqual(events.slice(-1).map((e) => [e.from, e.to, e.reason, e.detail]), [['ready', 'draft', 'task reopened', { taskId: 'T1' }]]);
  assert.equal(events.length, 3);
  const rescrubbed = buildClaim(s.store, cfg, s.encounterId);
  assert.equal(rescrubbed.status, 'ready');
  markSubmitted(s.store, ready.id, new Date());
  assert.throws(() => draftClaim(s.store, ready.id, 'too late'), InvalidTransitionError);
});
