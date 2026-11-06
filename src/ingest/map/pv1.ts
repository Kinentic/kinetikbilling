import type { IsoDateTime, PatientClass, Provider } from '../../domain/types.ts';
import { comp, firstSegment, parseHl7DateTime, type Hl7Message, type Hl7Segment } from '../../hl7/index.ts';
import { pidAccountNumber } from './pid.ts';
import { nonEmpty } from './text.ts';
import { mapXcn } from './xcn.ts';

export interface MappedEncounter {
  accountNumber: string;
  facility: string;
  visitNumber?: string;
  patientClass?: PatientClass;
  admitAt?: IsoDateTime;
  dischargeAt?: IsoDateTime;
  location?: string;
  attendingProvider?: Provider;
  referringProvider?: Provider;
  financialClass?: string;
  hospitalService?: string;
}

const CLASSES: ReadonlySet<string> = new Set<PatientClass>(['I', 'O', 'E', 'P', 'R', 'B', 'C', 'N', 'U']);
const mapClass = (s: string): PatientClass | undefined => (s === '' ? undefined : CLASSES.has(s) ? (s as PatientClass) : 'U');

function pv1Fields(pv1: Hl7Segment): Omit<MappedEncounter, 'accountNumber' | 'facility'> {
  const location = [1, 2, 3].map((c) => comp(pv1, 3, c).trim()).filter((s) => s !== '').join('-');
  return {
    visitNumber: nonEmpty(comp(pv1, 19)),
    patientClass: mapClass(comp(pv1, 2)),
    admitAt: parseHl7DateTime(comp(pv1, 44)),
    dischargeAt: parseHl7DateTime(comp(pv1, 45)),
    location: location || undefined,
    attendingProvider: mapXcn(pv1, 7),
    referringProvider: mapXcn(pv1, 8),
    financialClass: nonEmpty(comp(pv1, 20)),
    hospitalService: nonEmpty(comp(pv1, 10)),
  };
}

/** Encounter from PID-18 (fallback PV1-19) and PV1. Undefined when no account number identifies one. */
export function mapEncounter(msg: Hl7Message): MappedEncounter | undefined {
  const pid = firstSegment(msg, 'PID');
  const pv1 = firstSegment(msg, 'PV1');
  const accountNumber = (pid && pidAccountNumber(pid)) ?? (pv1 && nonEmpty(comp(pv1, 19)));
  if (!accountNumber) return undefined;
  const facility = (pv1 && nonEmpty(comp(pv1, 3, 4))) ?? msg.header.sendingFacility;
  return { accountNumber, facility, ...(pv1 ? pv1Fields(pv1) : {}) };
}
