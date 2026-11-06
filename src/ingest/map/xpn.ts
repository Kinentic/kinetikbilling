import type { PersonName } from '../../domain/types.ts';
import { repComp, reps, type Hl7Segment } from '../../hl7/index.ts';

/** XPN family^given^middle from the legal-name repetition (XPN.7 `L`), else the first. Empty strings when absent. */
export function mapXpn(seg: Hl7Segment, n: number): PersonName {
  const all = reps(seg, n);
  const rep = all.find((r) => repComp(r, 7) === 'L') ?? all[0] ?? [];
  const middleName = repComp(rep, 3);
  return { lastName: repComp(rep, 1), firstName: repComp(rep, 2), ...(middleName ? { middleName } : {}) };
}
