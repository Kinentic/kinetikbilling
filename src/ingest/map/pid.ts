import type { Address, IsoDate, PersonName, Sex, SourceIdentifier } from '../../domain/types.ts';
import { comp, parseHl7Date, repComp, reps, type Hl7Repetition, type Hl7Segment } from '../../hl7/index.ts';
import { IngestError } from '../handler.ts';
import { mapSex, nonEmpty } from './text.ts';
import { mapXad } from './xad.ts';
import { mapPhone } from './xtn.ts';
import { mapXpn } from './xpn.ts';

export interface MappedPatient extends PersonName {
  mrn: SourceIdentifier;
  dob?: IsoDate;
  sex?: Sex;
  address?: Address;
  phone?: string;
  ssnLast4?: string;
}

/** The CX repetition typed `MR`, else the first one. Undefined when none carries a value. */
export function selectMrn(cxs: readonly Hl7Repetition[]): SourceIdentifier | undefined {
  const rep = cxs.find((r) => repComp(r, 5) === 'MR') ?? cxs[0];
  const value = rep ? repComp(rep, 1).trim() : '';
  if (!rep || !value) return undefined;
  return { value, assigningAuthority: repComp(rep, 4), typeCode: repComp(rep, 5) };
}

function ssnLast4(pid: Hl7Segment): string | undefined {
  const ss = reps(pid, 3).find((r) => repComp(r, 5) === 'SS');
  const source = comp(pid, 19) || (ss ? repComp(ss, 1) : '');
  const digits = source.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

export function mapPid(pid: Hl7Segment): MappedPatient {
  const mrn = selectMrn(reps(pid, 3));
  if (!mrn) throw new IngestError('PID-3 has no MRN (no CX.1 value)');
  return {
    mrn,
    ...mapXpn(pid, 5),
    dob: parseHl7Date(comp(pid, 7)),
    sex: mapSex(comp(pid, 8)),
    address: mapXad(reps(pid, 11)[0]),
    phone: mapPhone(pid, 13),
    ssnLast4: ssnLast4(pid),
  };
}

/** PID-18 CX.1, the Cerner FIN. */
export const pidAccountNumber = (pid: Hl7Segment): string | undefined => nonEmpty(comp(pid, 18));
