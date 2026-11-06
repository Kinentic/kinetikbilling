import type { Store } from '../db/store.ts';
import { nowIso } from '../domain/ids.ts';
import type { Claim, ClaimId, ClaimStatus } from '../domain/types.ts';

export const TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ['ready', 'scrub_failed'],
  scrub_failed: ['draft', 'ready'],
  ready: ['submitted', 'draft'],
  submitted: ['accepted', 'rejected', 'paid', 'partially_paid', 'denied'],
  rejected: ['draft'],
  accepted: ['paid', 'partially_paid', 'denied'],
  partially_paid: ['paid', 'partially_paid', 'denied', 'closed'],
  paid: ['closed', 'partially_paid'],
  denied: ['draft', 'closed'],
  closed: [],
};

export class InvalidTransitionError extends Error {
  readonly from: ClaimStatus;
  readonly to: ClaimStatus;
  constructor(claimId: ClaimId, from: ClaimStatus, to: ClaimStatus) {
    super(`claim ${claimId}: cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class ClaimNotFoundError extends Error {
  constructor(key: string) {
    super(`claim not found: ${key}`);
    this.name = 'ClaimNotFoundError';
  }
}

export const canTransition = (from: ClaimStatus, to: ClaimStatus): boolean => TRANSITIONS[from].includes(to);

export const requireClaim = (store: Store, id: ClaimId): Claim => {
  const claim = store.getClaim(id);
  if (!claim) throw new ClaimNotFoundError(id);
  return claim;
};

/** Saves `claim` (with any field changes the caller made) under its new status and records the event. */
export const transition = (store: Store, claim: Claim, to: ClaimStatus, reason: string, detail?: unknown): Claim => {
  const current = requireClaim(store, claim.id).status;
  if (!canTransition(current, to)) throw new InvalidTransitionError(claim.id, current, to);
  const at = nowIso();
  const next: Claim = { ...claim, status: to, updatedAt: at };
  store.transaction(() => {
    store.saveClaim(next);
    store.appendClaimEvent({ claimId: claim.id, at, from: current, to, reason, detail });
  });
  return next;
};

/** A claim's first event has no `from`; it enters the lifecycle as draft. */
export const openClaim = (store: Store, claim: Omit<Claim, 'status'>, reason: string): Claim => {
  const opened: Claim = { ...claim, status: 'draft' };
  store.transaction(() => {
    store.saveClaim(opened);
    store.appendClaimEvent({ claimId: claim.id, at: claim.createdAt, from: null, to: 'draft', reason });
  });
  return opened;
};
