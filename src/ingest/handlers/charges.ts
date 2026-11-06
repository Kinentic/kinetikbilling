import { parseHl7Date, segments } from '../../hl7/index.ts';
import { IngestError, type MessageHandler } from '../handler.ts';
import type { CodingIntake } from '../intake.ts';
import { mapFt1, type MappedCharge } from '../map/ft1.ts';
import { ingestDemographics } from './demographics.ts';

/**
 * DFT^P03: demographics first, since DFT carries PID/PV1/IN1/DG1 and every DG1 must be on
 * the encounter before FT1-19 codes resolve. The intake then decides charges (pass-through)
 * or proposals (coder); the handler does not know which.
 */
export const charges = (intake: CodingIntake): MessageHandler => (store, msg, ctx) => {
  const { encounter, parts } = ingestDemographics(store, msg, ctx.now);
  if (!encounter) throw new IngestError('DFT^P03 has no account number: PID-18 and PV1-19 are empty');
  const mctx = { controlId: msg.header.controlId, messageDate: parseHl7Date(msg.header.timestamp) };
  const ft1s = segments(msg, 'FT1');
  const lines = ft1s.map((s) => mapFt1(s, mctx)).filter((c): c is MappedCharge => c !== undefined);
  parts.push(...intake.onCharges(store, encounter, lines, ctx));
  if (lines.length < ft1s.length) parts.push(`${ft1s.length - lines.length} FT1 skipped (FT1-6 not CG or CD)`);
  return { summary: parts.join(', ') };
};
