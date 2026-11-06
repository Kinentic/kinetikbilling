import type { Store } from '../db/store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import { ZERO_CENTS, addCents, type ChargeState, type Claim, type ClaimId, type ClaimStatus, type ClaimType, type CoveragePriority, type EncounterId } from '../domain/types.ts';
import type { BillingProviderConfig } from './config.ts';
import { loadClaimContext } from './context.ts';
import { hasErrors, scrubClaim } from './scrub.ts';
import { InvalidTransitionError, canTransition, openClaim, requireClaim, transition } from './state.ts';

export class NoCoverageError extends Error {
  constructor(encounterId: EncounterId, priority: CoveragePriority) {
    super(`encounter ${encounterId} has no coverage at priority ${priority}`);
    this.name = 'NoCoverageError';
  }
}

export class NoUnbilledChargesError extends Error {
  constructor(encounterId: EncounterId) {
    super(`encounter ${encounterId} has no unbilled charges`);
    this.name = 'NoUnbilledChargesError';
  }
}

export class EncounterNotFoundError extends Error {
  constructor(encounterId: EncounterId) {
    super(`encounter not found: ${encounterId}`);
    this.name = 'EncounterNotFoundError';
  }
}

/** Claims in these states still accept charges; anything later has gone to the payer. */
export const OPEN: readonly ClaimStatus[] = ['draft', 'scrub_failed', 'ready'];
const REWORKABLE: readonly ClaimStatus[] = ['rejected', 'denied', 'scrub_failed'];
const MAX_CONTROL_NUMBER = 20;

const sumCharges = (charges: readonly ChargeState[]): Claim['totalCharge'] => charges.reduce((t, c) => addCents(t, c.amount), ZERO_CENTS);

const nextControlNumber = (store: Store, accountNumber: string, encounterId: EncounterId): string => {
  const base = accountNumber.replace(/[^A-Za-z0-9-]/g, '');
  for (let seq = store.listClaims({ encounterId }).length + 1; ; seq++) {
    const suffix = `-${seq}`;
    const candidate = base.slice(-(MAX_CONTROL_NUMBER - suffix.length)) + suffix;
    if (!store.findClaimByControlNumber(candidate)) return candidate;
  }
};

/** Scrubs the claim's current charges and moves it to ready or scrub_failed. Repeating it with nothing changed is a no-op. */
export const rescrub = (store: Store, cfg: BillingProviderConfig, claimId: ClaimId): Claim => store.transaction(() => {
  const ctx = loadClaimContext(store, claimId);
  const claim: Claim = { ...ctx.claim, totalCharge: sumCharges(ctx.charges) };
  const violations = scrubClaim({ ...ctx, claim }, cfg);
  const target: ClaimStatus = hasErrors(violations) ? 'scrub_failed' : 'ready';
  if (!OPEN.includes(claim.status)) throw new InvalidTransitionError(claimId, claim.status, target);
  if (claim.status === target) {
    store.saveClaim(claim);
    return claim;
  }
  const from = canTransition(claim.status, target) ? claim : transition(store, claim, 'draft', 'rescrub');
  return transition(store, from, target, target === 'ready' ? 'scrub passed' : 'scrub failed', violations);
});

/**
 * Attaches every charge billable to the coverage to the open claim for it, opening one
 * when none exists, then rescrubs. An open claim is rescrubbed even with nothing new to
 * attach, because a charge on it may have been voided since; rescrub is a no-op when
 * nothing changed.
 */
export const buildClaim = (
  store: Store,
  cfg: BillingProviderConfig,
  encounterId: EncounterId,
  opts: { type?: ClaimType; coveragePriority?: CoveragePriority } = {},
): Claim => store.transaction(() => {
  const type = opts.type ?? 'professional';
  const priority = opts.coveragePriority ?? 1;
  const encounter = store.getEncounter(encounterId);
  if (!encounter) throw new EncounterNotFoundError(encounterId);
  const coverage = store.listCoverages(encounterId).find((c) => c.priority === priority);
  if (!coverage) throw new NoCoverageError(encounterId, priority);

  const billable = store.listBillableCharges(encounterId, coverage.id);
  const existing = store.listClaims({ encounterId }).find((c) => c.coverageId === coverage.id && c.type === type && OPEN.includes(c.status));
  if (billable.length === 0 && !existing) throw new NoUnbilledChargesError(encounterId);

  const now = nowIso();
  let claim: Claim;
  if (existing) {
    const reopen = billable.length > 0 && existing.status !== 'draft';
    claim = reopen ? transition(store, existing, 'draft', 'charges changed', { added: billable.map((c) => c.id) }) : existing;
  } else {
    claim = openClaim(store, {
      id: newId<ClaimId>(), encounterId, patientId: encounter.patientId, coverageId: coverage.id, type,
      controlNumber: nextControlNumber(store, encounter.accountNumber, encounterId),
      totalCharge: ZERO_CENTS, totalPaid: ZERO_CENTS, totalAdjusted: ZERO_CENTS, patientResponsibility: ZERO_CENTS,
      createdAt: now, updatedAt: now,
    }, 'built from unbilled charges');
  }
  store.attachCharges(claim.id, billable.map((c) => c.id), now);
  return rescrub(store, cfg, claim.id);
});

/**
 * Parks an open claim in draft so it cannot be submitted while its charges are being
 * recoded. Already draft: no-op. Not open: InvalidTransitionError.
 */
export const draftClaim = (store: Store, claimId: ClaimId, reason: string, detail?: unknown): Claim => store.transaction(() => {
  const claim = requireClaim(store, claimId);
  if (!OPEN.includes(claim.status)) throw new InvalidTransitionError(claimId, claim.status, 'draft');
  return claim.status === 'draft' ? claim : transition(store, claim, 'draft', reason, detail);
});

/** Sends a rejected, denied, or scrub-failed claim back through draft and scrubs it again. */
export const reworkClaim = (store: Store, cfg: BillingProviderConfig, claimId: ClaimId, reason = 'rework'): Claim => store.transaction(() => {
  const claim = requireClaim(store, claimId);
  if (!REWORKABLE.includes(claim.status)) throw new InvalidTransitionError(claimId, claim.status, 'draft');
  transition(store, claim, 'draft', reason);
  return rescrub(store, cfg, claimId);
});
