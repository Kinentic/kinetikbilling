// The only ingest module that reads or writes patient data in the store.
// Merge rule everywhere: an incoming value replaces the stored one only when
// it is present, so a message that omits a field never erases it.

import type { Store } from '../db/store.ts';
import { newId } from '../domain/ids.ts';
import type {
  Charge, ChargeId, CoverageId, Diagnosis, Encounter, EncounterId, IsoDateTime, Patient, PatientId, SourceIdentifier,
} from '../domain/types.ts';
import { IngestError } from './handler.ts';
import type { DiagnosisRef, MappedDiagnosis } from './map/dg1.ts';
import type { MappedCharge } from './map/ft1.ts';
import type { MappedGuarantor } from './map/gt1.ts';
import type { MappedCoverage } from './map/in1.ts';
import type { MappedPatient } from './map/pid.ts';
import type { MappedEncounter } from './map/pv1.ts';

function overlay<T extends object>(base: T, incoming: object): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(incoming)) if (v !== undefined && v !== '') out[k] = v;
  return out as T;
}

export const findPatient = (store: Store, mrn: SourceIdentifier): Patient | undefined =>
  store.findPatientByMrn(mrn.value, mrn.assigningAuthority);

export function upsertPatient(store: Store, mapped: MappedPatient, now: IsoDateTime): Patient {
  const existing = findPatient(store, mapped.mrn);
  const base: Patient = existing ?? { id: newId<PatientId>(), mrn: mapped.mrn, lastName: '', firstName: '', sex: 'U', updatedAt: now };
  const patient = overlay(base, { ...mapped, updatedAt: now });
  store.savePatient(patient);
  return patient;
}

export function mergePatients(store: Store, survivor: Patient, prior: Patient, now: IsoDateTime): void {
  store.mergePatients(survivor.id, prior.id, now);
}

/** Keyed on (facility, accountNumber). The account follows the patient Cerner sends it under. */
export function upsertEncounter(store: Store, patientId: PatientId, mapped: MappedEncounter, now: IsoDateTime): Encounter {
  const existing = store.findEncounter(mapped.facility, mapped.accountNumber);
  const base: Encounter = existing ?? {
    id: newId<EncounterId>(), patientId, accountNumber: mapped.accountNumber, facility: mapped.facility, patientClass: 'U', updatedAt: now,
  };
  const encounter = overlay(base, { ...mapped, patientId, updatedAt: now });
  store.saveEncounter(encounter);
  return encounter;
}

export function replaceCoverages(store: Store, encounterId: EncounterId, mapped: MappedCoverage[]): void {
  const seen = new Set<number>();
  for (const c of mapped) {
    if (seen.has(c.priority)) throw new IngestError(`IN1: two insurances resolve to priority ${c.priority} (IN1-22 / IN1-1)`);
    seen.add(c.priority);
  }
  store.replaceCoverages(encounterId, mapped.map((c) => ({ ...c, id: newId<CoverageId>(), encounterId })));
}

export function saveGuarantor(store: Store, encounterId: EncounterId, mapped: MappedGuarantor): void {
  store.saveGuarantor({ ...mapped, encounterId });
}

/** Adds `incoming` to `list` by code: a known code keeps its sequence, a new one takes its own if free, else the next. */
function mergeInto(list: Diagnosis[], encounterId: EncounterId, incoming: MappedDiagnosis): Diagnosis {
  const index = list.findIndex((d) => d.code === incoming.code);
  const known = list[index];
  if (known) {
    const merged = overlay(known, { ...incoming, sequence: known.sequence });
    list[index] = merged;
    return merged;
  }
  const taken = new Set(list.map((d) => d.sequence));
  const sequence = taken.has(incoming.sequence) ? Math.max(0, ...taken) + 1 : incoming.sequence;
  const added = { ...incoming, sequence, encounterId };
  list.push(added);
  return added;
}

export function mergeDiagnoses(store: Store, encounterId: EncounterId, incoming: MappedDiagnosis[]): Diagnosis[] {
  const list = store.listDiagnoses(encounterId);
  for (const d of incoming) mergeInto(list, encounterId, d);
  store.replaceDiagnoses(encounterId, list);
  return list;
}

export interface ChargeCounts { created: number; updated: number }

/**
 * Saves each charge keyed on (encounter, externalId). FT1-19 codes become
 * pointers (diagnosis sequences) on the encounter's list; a code the encounter
 * lacks is appended as a final diagnosis first.
 */
export function upsertCharges(store: Store, encounterId: EncounterId, charges: MappedCharge[]): ChargeCounts {
  const dx = store.listDiagnoses(encounterId);
  const before = dx.length;
  const pointerFor = (ref: DiagnosisRef): number =>
    dx.find((d) => d.code === ref.code)?.sequence
      ?? mergeInto(dx, encounterId, { ...ref, type: 'F', sequence: Math.max(0, ...dx.map((d) => d.sequence)) + 1 }).sequence;

  const counts: ChargeCounts = { created: 0, updated: 0 };
  const rows: Charge[] = charges.map(({ diagnoses, ...line }) => {
    const existing = store.findCharge(encounterId, line.externalId);
    counts[existing ? 'updated' : 'created']++;
    return {
      ...line,
      id: existing?.id ?? newId<ChargeId>(),
      encounterId,
      status: existing?.status ?? 'unbilled',
      ...(existing?.claimId ? { claimId: existing.claimId } : {}),
      diagnosisPointers: diagnoses.map(pointerFor),
    };
  });
  if (dx.length > before) store.replaceDiagnoses(encounterId, dx);
  for (const row of rows) store.saveCharge(row);
  return counts;
}
