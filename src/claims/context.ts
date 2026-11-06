import type { Store } from '../db/store.ts';
import type { ChargeState, Claim, ClaimDiagnosis, ClaimId, Coverage, Encounter, Guarantor, Patient } from '../domain/types.ts';
import { requireClaim } from './state.ts';

export interface ClaimContext {
  claim: Claim;
  patient: Patient;
  encounter: Encounter;
  /** Absent only when the coverage row is gone; the scrubber reports it. */
  coverage?: Coverage;
  /** Linked through claim_charges, not voided, in service-date order. */
  charges: ChargeState[];
  /** The HI list, derived from the charges by claimDiagnoses. */
  diagnoses: ClaimDiagnosis[];
  guarantor?: Guarantor;
}

export class ClaimContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimContextError';
  }
}

/**
 * Distinct codes across the charges' diagnoses, ordered by the lowest sequence any
 * charge gave the code and then by first appearance, numbered 1..n. Every code on a
 * line is in the list by construction, so a pointer can never dangle. The 837P writer
 * caps the list at 12; the claim-dx-count rule reports the overflow first.
 */
export const claimDiagnoses = (charges: readonly ChargeState[]): ClaimDiagnosis[] => {
  const seen = new Map<string, { entry: Omit<ClaimDiagnosis, 'position'>; sequence: number; order: number }>();
  for (const charge of charges) {
    for (const d of charge.diagnoses) {
      const known = seen.get(d.code);
      if (known) known.sequence = Math.min(known.sequence, d.sequence);
      else seen.set(d.code, { entry: { code: d.code, codingSystem: d.codingSystem, ...(d.description ? { description: d.description } : {}) }, sequence: d.sequence, order: seen.size });
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.sequence - b.sequence || a.order - b.order)
    .map((e, i) => ({ position: i + 1, ...e.entry }));
};

/** Positions of the charge's own codes in the claim list, in the charge's order, at most 4 (837P SV1-7). */
export const pointersFor = (charge: ChargeState, list: readonly ClaimDiagnosis[]): number[] =>
  charge.diagnoses
    .map((d) => list.find((l) => l.code === d.code)?.position)
    .filter((p): p is number => p !== undefined)
    .slice(0, 4);

export const loadClaimContext = (store: Store, claimId: ClaimId): ClaimContext => {
  const claim = requireClaim(store, claimId);
  const encounter = store.getEncounter(claim.encounterId);
  if (!encounter) throw new ClaimContextError(`claim ${claimId}: encounter ${claim.encounterId} not found`);
  // The encounter, not the claim, follows patient merges (ADT^A40 moves encounters to the survivor).
  const patient = store.getPatient(encounter.patientId);
  if (!patient) throw new ClaimContextError(`claim ${claimId}: patient ${encounter.patientId} not found`);
  const coverage = store.getCoverage(claim.coverageId);
  const guarantor = store.getGuarantor(encounter.id);
  const charges = store.listCharges({ claimId }).filter((c) => c.status !== 'voided');
  return {
    claim,
    patient,
    encounter,
    ...(coverage ? { coverage } : {}),
    charges,
    diagnoses: claimDiagnoses(charges),
    ...(guarantor ? { guarantor } : {}),
  };
};
