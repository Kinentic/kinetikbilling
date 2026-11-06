import type { Coverage, CoveragePriority } from '../../domain/types.ts';
import { comp, parseHl7Date, reps, type Hl7Segment } from '../../hl7/index.ts';
import type { MappedPatient } from './pid.ts';
import { mapRelationship } from './relationship.ts';
import { mapSex, nonEmpty } from './text.ts';
import { mapXad } from './xad.ts';
import { mapXpn } from './xpn.ts';

export type MappedCoverage = Omit<Coverage, 'id' | 'encounterId'>;

function priority(in1: Hl7Segment): CoveragePriority {
  const explicit = comp(in1, 22).trim();
  if (explicit === '1' || explicit === '2' || explicit === '3') return Number(explicit) as CoveragePriority;
  const setId = Number.parseInt(comp(in1, 1), 10);
  return (Number.isNaN(setId) ? 1 : Math.min(3, Math.max(1, setId))) as CoveragePriority;
}

export function mapIn1(in1: Hl7Segment, patient: MappedPatient): MappedCoverage {
  const relationship = mapRelationship(comp(in1, 17));
  const name = mapXpn(in1, 16);
  const subscriber = relationship === 'self' && !name.lastName && !name.firstName
    ? { lastName: patient.lastName, firstName: patient.firstName, middleName: patient.middleName, dob: patient.dob, sex: patient.sex }
    : { ...name, dob: parseHl7Date(comp(in1, 18)), sex: mapSex(comp(in1, 43)) };
  return {
    priority: priority(in1),
    payerId: comp(in1, 3).trim(),
    payerName: comp(in1, 4).trim(),
    payerAddress: mapXad(reps(in1, 5)[0]),
    planId: nonEmpty(comp(in1, 2, 1)),
    planName: nonEmpty(comp(in1, 2, 2)),
    groupNumber: nonEmpty(comp(in1, 8)),
    // An empty member id is stored as '' so the scrubber flags it rather than ingest rejecting the message.
    memberId: nonEmpty(comp(in1, 36)) ?? nonEmpty(comp(in1, 49)) ?? '',
    relationship,
    subscriber: { ...subscriber, address: mapXad(reps(in1, 19)[0]) },
    effectiveFrom: parseHl7Date(comp(in1, 12)),
    effectiveTo: parseHl7Date(comp(in1, 13)),
  };
}
