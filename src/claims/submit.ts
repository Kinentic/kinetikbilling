import type { Store } from '../db/store.ts';
import type { Claim, ClaimId, IsoDateTime } from '../domain/types.ts';
import { requireClaim, transition } from './state.ts';

export const markSubmitted = (store: Store, claimId: ClaimId, now: Date): Claim => {
  const claim = requireClaim(store, claimId);
  return transition(store, { ...claim, submittedAt: now.toISOString() as IsoDateTime }, 'submitted', 'submitted to clearinghouse');
};

export const acknowledge = (store: Store, claimId: ClaimId, accepted: boolean, detail?: unknown): Claim =>
  transition(store, requireClaim(store, claimId), accepted ? 'accepted' : 'rejected', accepted ? 'payer acknowledged' : 'payer rejected', detail);

export const closeClaim = (store: Store, claimId: ClaimId, reason: string): Claim =>
  transition(store, requireClaim(store, claimId), 'closed', reason);
