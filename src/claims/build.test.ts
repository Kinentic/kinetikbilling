import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, type ScrubViolation } from '../domain/types.ts';
import { NoCoverageError, NoUnbilledChargesError, buildClaim, reworkClaim } from './build.ts';
import { acknowledge, markSubmitted } from './submit.ts';
import { InvalidTransitionError } from './state.ts';
import { addCharge, cfg, seed } from './testkit.ts';

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
    assert.equal(stored.claimId, claim.id);
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
  assert.equal(s.store.getCharge(late.id)!.claimId, first.id);
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
