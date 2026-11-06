import type { Guarantor } from '../../domain/types.ts';
import { comp, reps, type Hl7Segment } from '../../hl7/index.ts';
import { mapRelationship } from './relationship.ts';
import { mapXad } from './xad.ts';
import { mapPhone } from './xtn.ts';
import { mapXpn } from './xpn.ts';

export type MappedGuarantor = Omit<Guarantor, 'encounterId'>;

export function mapGt1(gt1: Hl7Segment): MappedGuarantor {
  return {
    ...mapXpn(gt1, 3),
    address: mapXad(reps(gt1, 5)[0]),
    phone: mapPhone(gt1, 6),
    relationship: mapRelationship(comp(gt1, 11)),
  };
}
