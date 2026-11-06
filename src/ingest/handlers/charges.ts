import { parseHl7Date, segments } from '../../hl7/index.ts';
import { IngestError, type MessageHandler } from '../handler.ts';
import { mapFt1, type MappedCharge } from '../map/ft1.ts';
import { upsertCharges } from '../upsert.ts';
import { ingestDemographics } from './demographics.ts';

/**
 * DFT^P03: demographics first, since DFT carries PID/PV1/IN1/DG1. Every DG1,
 * including ones some Cerner builds place after an FT1, joins the encounter
 * list before FT1-19 codes resolve to pointers.
 */
export const charges: MessageHandler = (store, msg, now) => {
  const { encounter, parts } = ingestDemographics(store, msg, now);
  if (!encounter) throw new IngestError('DFT^P03 has no account number: PID-18 and PV1-19 are empty');
  const ctx = { controlId: msg.header.controlId, messageDate: parseHl7Date(msg.header.timestamp) };
  const ft1s = segments(msg, 'FT1');
  const lines = ft1s.map((s) => mapFt1(s, ctx)).filter((c): c is MappedCharge => c !== undefined);
  const { created, updated } = upsertCharges(store, encounter.id, lines);
  parts.push(`${lines.length} charge${lines.length === 1 ? '' : 's'} (${created} new, ${updated} updated)`);
  if (lines.length < ft1s.length) parts.push(`${ft1s.length - lines.length} FT1 skipped (FT1-6 not CG or CD)`);
  return { summary: parts.join(', ') };
};
