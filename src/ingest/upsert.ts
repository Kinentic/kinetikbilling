// The only ingest module that reads or writes patient data in the store.
// Merge rule everywhere: an incoming value replaces the stored one only when
// it is present, so a message that omits a field never erases it.

import type { Store } from '../db/store.ts';
import { newId } from '../domain/ids.ts';
import type {
  CernerCharge, ChargeDiagnosis, ChargeId, CoverageId, Diagnosis, Document, DocumentId, Encounter, EncounterId, IsoDateTime, MessageId, Patient, PatientId,
  SourceIdentifier,
} from '../domain/types.ts';
import { IngestError } from './handler.ts';
import type { DiagnosisRef, MappedDiagnosis } from './map/dg1.ts';
import type { MappedDocument } from './map/document.ts';
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
 * Saves each FT1 line as a Cerner charge keyed on (encounter, FT1-2). An FT1-19 code
 * joins the encounter's diagnosis list first (appended as a final diagnosis when the
 * encounter lacks it) so it has a sequence, then lands on the charge by value. Claim
 * links live in claim_charges, so an in-place update carries nothing forward.
 */
export function upsertCharges(store: Store, encounterId: EncounterId, charges: readonly MappedCharge[]): ChargeCounts {
  const dx = store.listDiagnoses(encounterId);
  const before = dx.length;
  const byValue = (ref: DiagnosisRef): ChargeDiagnosis => {
    const d = dx.find((x) => x.code === ref.code)
      ?? mergeInto(dx, encounterId, { ...ref, type: 'F', sequence: Math.max(0, ...dx.map((x) => x.sequence)) + 1 });
    return { sequence: d.sequence, code: d.code, codingSystem: d.codingSystem, ...(d.description ? { description: d.description } : {}) };
  };

  const counts: ChargeCounts = { created: 0, updated: 0 };
  const rows: CernerCharge[] = charges.map(({ diagnosisRefs, ...line }) => {
    const existing = store.findCernerCharge(encounterId, line.externalId);
    counts[existing ? 'updated' : 'created']++;
    return { ...line, id: existing?.id ?? newId<ChargeId>(), encounterId, source: 'cerner_dft', diagnoses: diagnosisRefs.map(byValue) };
  });
  if (dx.length > before) store.replaceDiagnoses(encounterId, dx);
  for (const row of rows) store.saveCernerCharge(row);
  return counts;
}

export interface DocumentAppend {
  /** The version now current for (encounter, externalId): the one written, or the stored one when nothing was. */
  document: Document;
  /**
   * new          first version of this externalId
   * new_version  content differs from the latest version (a correction, or a final after a preliminary)
   * unchanged    identical to the latest version: redelivery under a new MSH-10, or a retry; nothing written
   * stale        a preliminary arriving after a final for the same externalId; nothing written
   */
  outcome: 'new' | 'new_version' | 'unchanged' | 'stale';
  /** The version this one supersedes, when outcome is new_version. */
  prior?: Document;
}

const documentContent = (d: MappedDocument): string => JSON.stringify([d.kind, d.status, d.title ?? null, d.author?.npi ?? null, d.signedAt ?? null, d.observedAt ?? null, d.body, d.attachment ?? null]);

/**
 * The single writer of documents. Compares the mapped content (kind, status, title, author
 * NPI, signedAt, observedAt, body, attachment) with the latest version for (encounter,
 * externalId) and appends version n+1 only when it differs. This is what makes a resent
 * MDM/ORU create no second version and no second task fact.
 */
export function appendDocumentVersion(store: Store, encounterId: EncounterId, messageId: MessageId, mapped: MappedDocument, now: IsoDateTime): DocumentAppend {
  const latest = store.latestDocumentVersion(encounterId, mapped.externalId);
  if (latest) {
    if (mapped.status === 'preliminary' && latest.status !== 'preliminary') return { document: latest, outcome: 'stale' };
    if (documentContent(latest) === documentContent(mapped)) return { document: latest, outcome: 'unchanged' };
  }
  const document: Document = { ...mapped, id: newId<DocumentId>(), encounterId, messageId, version: (latest?.version ?? 0) + 1, recordedAt: now };
  store.appendDocument(document);
  return latest ? { document, outcome: 'new_version', prior: latest } : { document, outcome: 'new' };
}
