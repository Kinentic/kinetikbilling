import type { Hl7Message } from '../../hl7/index.ts';
import { IngestError, type MessageHandler } from '../handler.ts';
import type { CodingIntake } from '../intake.ts';
import type { MappedDocument } from '../map/document.ts';
import { appendDocumentVersion } from '../upsert.ts';
import { ingestDemographics } from './demographics.ts';

/**
 * MDM^T02/T04/T08/T10 and ORU^R01: demographics (a stub encounter if no ADT came yet), then
 * one Document version per mapped document, then the intake. Replay-safe by construction:
 * ingestDemographics overlays; appendDocumentVersion writes nothing for identical content;
 * the coder intake raises a task fact only for an appended final or corrected version.
 */
export const documents = (map: (msg: Hl7Message) => MappedDocument[], intake: CodingIntake): MessageHandler => (store, msg, ctx) => {
  const { encounter, parts } = ingestDemographics(store, msg, ctx.now);
  if (!encounter) throw new IngestError(`${msg.header.messageType}^${msg.header.triggerEvent} has no account number: PID-18 and PV1-19 are empty`);
  const mapped = map(msg);
  if (mapped.length === 0) throw new IngestError('no document: TXA (MDM) or OBR (ORU) segment missing');
  for (const doc of mapped) {
    const appended = appendDocumentVersion(store, encounter.id, ctx.messageId, doc, ctx.now);
    parts.push(`document ${doc.externalId} ${appended.outcome}`);
    parts.push(...intake.onDocument(store, encounter, appended, ctx));
  }
  return { summary: parts.join(', ') };
};
