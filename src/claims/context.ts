import type { Store } from '../db/store.ts';
import type { Charge, Claim, ClaimId, Coverage, Diagnosis, Encounter, Guarantor, Patient } from '../domain/types.ts';
import { requireClaim } from './state.ts';

export interface ClaimContext {
  claim: Claim;
  patient: Patient;
  encounter: Encounter;
  /** Absent only when the coverage row is gone; the scrubber reports it. */
  coverage?: Coverage;
  /** Attached, non-voided charges in service-date order. */
  charges: Charge[];
  /** Encounter diagnoses in sequence order. */
  diagnoses: Diagnosis[];
  guarantor?: Guarantor;
}

export class ClaimContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimContextError';
  }
}

export const loadClaimContext = (store: Store, claimId: ClaimId): ClaimContext => {
  const claim = requireClaim(store, claimId);
  const encounter = store.getEncounter(claim.encounterId);
  if (!encounter) throw new ClaimContextError(`claim ${claimId}: encounter ${claim.encounterId} not found`);
  // The encounter, not the claim, follows patient merges (ADT^A40 moves encounters to the survivor).
  const patient = store.getPatient(encounter.patientId);
  if (!patient) throw new ClaimContextError(`claim ${claimId}: patient ${encounter.patientId} not found`);
  const coverage = store.getCoverage(claim.coverageId);
  const guarantor = store.getGuarantor(encounter.id);
  return {
    claim,
    patient,
    encounter,
    ...(coverage ? { coverage } : {}),
    charges: store.listCharges({ claimId }).filter((c) => c.status !== 'voided'),
    diagnoses: store.listDiagnoses(encounter.id),
    ...(guarantor ? { guarantor } : {}),
  };
};
