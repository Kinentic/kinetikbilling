import type { Store } from '../db/store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import { ZERO_CENTS, addCents, type Charge, type Claim, type ClaimId, type ClaimStatus, type ClaimType, type CoveragePriority, type EncounterId } from '../domain/types.ts';
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
const OPEN: readonly ClaimStatus[] = ['draft', 'scrub_failed', 'ready'];
const REWORKABLE: readonly ClaimStatus[] = ['rejected', 'denied', 'scrub_failed'];
const MAX_CONTROL_NUMBER = 20;

const sumCharges = (charges: readonly Charge[]): Claim['totalCharge'] => charges.reduce((t, c) => addCents(t, c.amount), ZERO_CENTS);

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

  const unbilled = store.listCharges({ encounterId, status: 'unbilled' });
  const existing = store.listClaims({ encounterId }).find((c) => c.coverageId === coverage.id && c.type === type && OPEN.includes(c.status));
  if (unbilled.length === 0) {
    if (existing) return existing;
    throw new NoUnbilledChargesError(encounterId);
  }

  let claim: Claim;
  if (existing) {
    claim = existing.status === 'draft' ? existing : transition(store, existing, 'draft', 'charges changed', { added: unbilled.map((c) => c.id) });
  } else {
    const now = nowIso();
    claim = openClaim(store, {
      id: newId<ClaimId>(), encounterId, patientId: encounter.patientId, coverageId: coverage.id, type,
      controlNumber: nextControlNumber(store, encounter.accountNumber, encounterId),
      totalCharge: ZERO_CENTS, totalPaid: ZERO_CENTS, totalAdjusted: ZERO_CENTS, patientResponsibility: ZERO_CENTS,
      createdAt: now, updatedAt: now,
    }, 'built from unbilled charges');
  }
  for (const c of unbilled) store.saveCharge({ ...c, status: 'claimed', claimId: claim.id });
  return rescrub(store, cfg, claim.id);
});

/** Sends a rejected, denied, or scrub-failed claim back through draft and scrubs it again. */
export const reworkClaim = (store: Store, cfg: BillingProviderConfig, claimId: ClaimId, reason = 'rework'): Claim => store.transaction(() => {
  const claim = requireClaim(store, claimId);
  if (!REWORKABLE.includes(claim.status)) throw new InvalidTransitionError(claimId, claim.status, 'draft');
  transition(store, claim, 'draft', reason);
  return rescrub(store, cfg, claimId);
});
