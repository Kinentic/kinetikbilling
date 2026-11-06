import type { Address } from '../../domain/types.ts';
import { repComp, type Hl7Repetition } from '../../hl7/index.ts';

/** XAD: 1 street, 2 other designation, 3 city, 4 state, 5 zip. Undefined when all five are empty. */
export function mapXad(rep: Hl7Repetition | undefined): Address | undefined {
  if (!rep) return undefined;
  const [line1, line2, city, state, zip] = [1, 2, 3, 4, 5].map((c) => repComp(rep, c).trim()) as [string, string, string, string, string];
  if (!line1 && !line2 && !city && !state && !zip) return undefined;
  return { line1, ...(line2 ? { line2 } : {}), city, state, zip };
}
