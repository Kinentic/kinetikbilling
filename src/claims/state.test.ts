import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, nowIso } from '../domain/ids.ts';
import { ZERO_CENTS, type Claim, type ClaimId, type ClaimStatus } from '../domain/types.ts';
import { InvalidTransitionError, TRANSITIONS, transition } from './state.ts';
import { seed } from './testkit.ts';

const ALL = Object.keys(TRANSITIONS) as ClaimStatus[];

const claimIn = (status: ClaimStatus) => {
  const s = seed();
  const now = nowIso();
  const claim: Claim = {
    id: newId<ClaimId>(), encounterId: s.encounterId, patientId: s.patientId, coverageId: s.coverage.id, type: 'professional', status,
    controlNumber: `C-${status}`, totalCharge: ZERO_CENTS, totalPaid: ZERO_CENTS, totalAdjusted: ZERO_CENTS, patientResponsibility: ZERO_CENTS,
    createdAt: now, updatedAt: now,
  };
  s.store.saveClaim(claim);
  return { ...s, claim };
};

for (const from of ALL) {
  const illegal = ALL.filter((to) => !TRANSITIONS[from].includes(to));
  test(`${from}: every move outside the table throws and changes nothing`, () => {
    for (const to of illegal) {
      const { store, claim } = claimIn(from);
      assert.throws(() => transition(store, claim, to, 'test'), (e: unknown) =>
        e instanceof InvalidTransitionError && e.from === from && e.to === to);
      assert.equal(store.getClaim(claim.id)!.status, from);
      assert.deepEqual(store.listClaimEvents(claim.id), []);
    }
  });
  for (const to of TRANSITIONS[from]) {
    test(`${from} -> ${to} saves the status and records the event`, () => {
      const { store, claim } = claimIn(from);
      const out = transition(store, claim, to, 'because', { k: 1 });
      assert.equal(out.status, to);
      assert.equal(store.getClaim(claim.id)!.status, to);
      const events = store.listClaimEvents(claim.id);
      assert.equal(events.length, 1);
      assert.deepEqual({ ...events[0], at: undefined }, { claimId: claim.id, at: undefined, from, to, reason: 'because', detail: { k: 1 } });
    });
  }
}

test('closed is terminal', () => {
  assert.deepEqual(TRANSITIONS.closed, []);
});

test('the stored status decides, not a stale in-memory copy', () => {
  const { store, claim } = claimIn('draft');
  transition(store, claim, 'ready', 'scrub passed');
  assert.throws(() => transition(store, claim, 'scrub_failed', 'stale'), InvalidTransitionError);
});
