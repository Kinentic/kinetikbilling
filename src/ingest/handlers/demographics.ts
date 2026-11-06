import type { Store } from '../../db/store.ts';
import type { Encounter, IsoDateTime, Patient } from '../../domain/types.ts';
import { firstSegment, segments, type Hl7Message } from '../../hl7/index.ts';
import { IngestError, type MessageHandler } from '../handler.ts';
import { mapDg1, type MappedDiagnosis } from '../map/dg1.ts';
import { mapGt1 } from '../map/gt1.ts';
import { mapIn1 } from '../map/in1.ts';
import { mapPid } from '../map/pid.ts';
import { mapEncounter } from '../map/pv1.ts';
import { mergeDiagnoses, replaceCoverages, saveGuarantor, upsertEncounter, upsertPatient } from '../upsert.ts';

export interface DemographicsOutcome {
  patient: Patient;
  encounter?: Encounter;
  /** Summary fragments, joined with ', ' by the caller. */
  parts: string[];
}

/**
 * Upserts patient, then (when an account number identifies the encounter)
 * encounter, coverages, guarantor and diagnoses from whatever segments are
 * present. `dischargeFallback` fills dischargeAt when PV1-45 is empty.
 */
export function ingestDemographics(store: Store, msg: Hl7Message, now: IsoDateTime, dischargeFallback?: IsoDateTime): DemographicsOutcome {
  const pid = firstSegment(msg, 'PID');
  if (!pid) throw new IngestError(`${msg.header.messageType}^${msg.header.triggerEvent} has no PID segment`);
  const mappedPatient = mapPid(pid);
  const patient = upsertPatient(store, mappedPatient, now);
  const parts = [`patient ${patient.mrn.value} upserted`];

  const mapped = mapEncounter(msg);
  if (!mapped) {
    parts.push('no account number in PID-18 or PV1-19, patient only');
    return { patient, parts };
  }
  // A late message under a merged-away MRN must not pull the account back from the survivor.
  const ownerId = patient.mergedInto ?? patient.id;
  const encounter = upsertEncounter(store, ownerId, { ...mapped, dischargeAt: mapped.dischargeAt ?? dischargeFallback }, now);
  parts.push(`encounter ${encounter.accountNumber} upserted`);

  const in1s = segments(msg, 'IN1');
  if (in1s.length > 0) {
    replaceCoverages(store, encounter.id, in1s.map((s) => mapIn1(s, mappedPatient)));
    parts.push(`${in1s.length} coverage${in1s.length === 1 ? '' : 's'}`);
  }
  const gt1 = firstSegment(msg, 'GT1');
  if (gt1) {
    saveGuarantor(store, encounter.id, mapGt1(gt1));
    parts.push('guarantor');
  }
  const dg1s = segments(msg, 'DG1');
  const diagnoses = dg1s.map(mapDg1).filter((d): d is MappedDiagnosis => d !== undefined);
  if (diagnoses.length > 0) {
    const list = mergeDiagnoses(store, encounter.id, diagnoses);
    parts.push(`${diagnoses.length} diagnos${diagnoses.length === 1 ? 'is' : 'es'} merged (${list.length} on encounter)`);
  }
  if (diagnoses.length < dg1s.length) parts.push(`${dg1s.length - diagnoses.length} DG1 without DG1-3 code skipped`);
  return { patient, encounter, parts };
}

export const demographics: MessageHandler = (store, msg, now) => ({ summary: ingestDemographics(store, msg, now).parts.join(', ') });
