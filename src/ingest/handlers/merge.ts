import { firstSegment, reps } from '../../hl7/index.ts';
import { IngestError, type MessageHandler } from '../handler.ts';
import { mapPid, selectMrn } from '../map/pid.ts';
import { findPatient, mergePatients, upsertPatient } from '../upsert.ts';

/** ADT^A40: PID is the survivor, MRG-1 names the prior MRN whose encounters move to it. */
export const merge: MessageHandler = (store, msg, { now }) => {
  const pid = firstSegment(msg, 'PID');
  if (!pid) throw new IngestError('ADT^A40 has no PID segment');
  const mrg = firstSegment(msg, 'MRG');
  if (!mrg) throw new IngestError('ADT^A40 has no MRG segment');
  const priorMrn = selectMrn(reps(mrg, 1));
  if (!priorMrn) throw new IngestError('MRG-1 has no prior MRN (no CX.1 value)');

  const survivor = upsertPatient(store, mapPid(pid), now);
  const prior = findPatient(store, { ...priorMrn, assigningAuthority: priorMrn.assigningAuthority || survivor.mrn.assigningAuthority });
  const head = `patient ${survivor.mrn.value} upserted`;
  if (!prior) return { summary: `${head}, prior MRN ${priorMrn.value} not on file, nothing to merge` };
  if (prior.id === survivor.id) return { summary: `${head}, prior MRN ${priorMrn.value} is the survivor, nothing to merge` };
  mergePatients(store, survivor, prior, now);
  return { summary: `${head}, patient ${prior.mrn.value} merged into it` };
};
