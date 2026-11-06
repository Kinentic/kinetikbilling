import type { Diagnosis, DiagnosisType } from '../../domain/types.ts';
import { comp, type Hl7Segment } from '../../hl7/index.ts';
import { nonEmpty } from './text.ts';

export type MappedDiagnosis = Omit<Diagnosis, 'encounterId'>;
/** A diagnosis code as cited elsewhere (FT1-19), before it has a sequence on the encounter. */
export type DiagnosisRef = Pick<Diagnosis, 'code' | 'codingSystem' | 'description'>;

const CODING_SYSTEMS: Readonly<Record<string, Diagnosis['codingSystem']>> = {
  I10: 'ICD10', ICD10: 'ICD10', 'ICD-10': 'ICD10', ICD10CM: 'ICD10', ABK: 'ICD10', ABF: 'ICD10',
  I9: 'ICD9', ICD9: 'ICD9',
};
export const codingSystemOf = (ce3: string): Diagnosis['codingSystem'] => CODING_SYSTEMS[ce3.trim().toUpperCase()] ?? 'OTHER';
export const normalizeDxCode = (code: string): string => code.replace(/\s+/g, '');

const TYPES: ReadonlySet<string> = new Set<DiagnosisType>(['A', 'W', 'F']);
const isNumeric = (s: string): boolean => /^\d+$/.test(s.trim());

/** Undefined when DG1-3 carries no code. `position` is the 0-based index among the message's DG1 segments. */
export function mapDg1(dg1: Hl7Segment, position: number): MappedDiagnosis | undefined {
  const code = normalizeDxCode(comp(dg1, 3, 1));
  if (!code) return undefined;
  const type = comp(dg1, 6).trim();
  const priority = comp(dg1, 15);
  const setId = comp(dg1, 1);
  return {
    sequence: isNumeric(priority) ? Number(priority) : isNumeric(setId) ? Number(setId) : position + 1,
    code,
    codingSystem: codingSystemOf(comp(dg1, 3, 3)),
    description: nonEmpty(comp(dg1, 3, 2)),
    type: TYPES.has(type) ? (type as DiagnosisType) : 'F',
    presentOnAdmission: nonEmpty(comp(dg1, 26)),
  };
}
