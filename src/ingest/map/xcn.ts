import type { Provider } from '../../domain/types.ts';
import { repComp, reps, type Hl7Segment } from '../../hl7/index.ts';

/** Provider from an XCN field: the repetition whose XCN.13 is NPI, else the first. Undefined when the field is empty. */
export function mapXcn(seg: Hl7Segment, n: number): Provider | undefined {
  const all = reps(seg, n);
  const rep = all.find((r) => repComp(r, 13) === 'NPI') ?? all[0];
  if (!rep) return undefined;
  const middleName = repComp(rep, 4);
  return { npi: repComp(rep, 1), lastName: repComp(rep, 2), firstName: repComp(rep, 3), ...(middleName ? { middleName } : {}) };
}
