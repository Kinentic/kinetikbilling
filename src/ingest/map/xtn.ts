import { repComp, reps, type Hl7Segment } from '../../hl7/index.ts';
import { nonEmpty } from './text.ts';

/** First XTN repetition: area code (6) + local number (7) when the local number is present, else XTN.1. */
export function mapPhone(seg: Hl7Segment, n: number): string | undefined {
  const rep = reps(seg, n)[0];
  if (!rep) return undefined;
  const local = repComp(rep, 7).trim();
  return local ? `${repComp(rep, 6).trim()}${local}` : nonEmpty(repComp(rep, 1));
}
