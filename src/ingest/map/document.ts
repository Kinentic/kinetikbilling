// Pure mappers: an MDM or ORU message to the documents it carries. One file for the
// family (TXA, OBR, OBX together) because OBX text belongs to whichever header precedes it.

import type { Document, DocumentKind, DocumentStatus } from '../../domain/types.ts';
import { comp, parseHl7DateTime, repComp, reps, type Hl7Message, type Hl7Segment } from '../../hl7/index.ts';
import { nonEmpty } from './text.ts';
import { mapXcn } from './xcn.ts';

/** Document minus identity, ownership and versioning, which appendDocumentVersion assigns. */
export type MappedDocument = Omit<Document, 'id' | 'encounterId' | 'messageId' | 'version' | 'recordedAt'>;

const KINDS: Readonly<Record<string, DocumentKind>> = {
  PN: 'progress_note', PROG: 'progress_note', 'H&P': 'progress_note', HP: 'progress_note', CONS: 'progress_note', CN: 'progress_note', DS: 'progress_note',
  RAD: 'radiology_report', RA: 'radiology_report',
};
const AUTHENTICATED: ReadonlySet<string> = new Set(['AU', 'LA']);
const CORRECTION_TRIGGERS: ReadonlySet<string> = new Set(['T08', 'T10']);
const TEXT_TYPES: ReadonlySet<string> = new Set(['TX', 'FT', 'ST']);
const HEADERS: ReadonlySet<string> = new Set(['TXA', 'OBR']);

const defined = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

/**
 * MDM: one document from TXA plus the OBX segments that follow it.
 *   externalId  TXA-12.1; for T10 with TXA-13 present, TXA-13.1 (the replacement continues the parent's chain)
 *   kind        TXA-2.1 via KINDS (else other)
 *   status      TXA-17 AU|LA -> final, `corrected` when the trigger is T08/T10; else preliminary
 *   author      TXA-5, else TXA-22 authenticator
 *   signedAt    TXA-22 time component (PPN.15), else TXA-4
 *   title       TXA-2.2
 * Returns [] when TXA is absent.
 */
export function mapMdm(msg: Hl7Message): MappedDocument[] {
  const txa = msg.segments.find((s) => s.name === 'TXA');
  if (!txa) return [];
  const trigger = msg.header.triggerEvent;
  const replacement = trigger === 'T10' ? nonEmpty(comp(txa, 13, 1)) : undefined;
  const externalId = replacement ?? nonEmpty(comp(txa, 12, 1)) ?? `${msg.header.controlId}-TXA`;
  const authenticated = AUTHENTICATED.has(comp(txa, 17).trim().toUpperCase());
  const status: DocumentStatus = !authenticated ? 'preliminary' : CORRECTION_TRIGGERS.has(trigger) ? 'corrected' : 'final';
  return [defined({
    externalId,
    kind: KINDS[comp(txa, 2, 1).trim().toUpperCase()] ?? 'other',
    status,
    title: nonEmpty(comp(txa, 2, 2)),
    author: mapXcn(txa, 5) ?? mapXcn(txa, 22),
    signedAt: parseHl7DateTime(comp(txa, 22, 15)) ?? parseHl7DateTime(comp(txa, 4)),
    ...obxBody(msg, txa),
  })];
}

const ORU_STATUS: Readonly<Record<string, DocumentStatus>> = { F: 'final', C: 'corrected' };

/**
 * ORU: one radiology_report per OBR, with the OBX segments up to the next OBR.
 *   externalId  OBR-3.1 (filler order number), else OBR-2.1
 *   status      OBR-25: F -> final, C -> corrected, anything else preliminary
 *   author      OBX-16 responsible observer, else OBR-32 principal interpreter (NDL.1 subcomponents npi&last&first)
 *   signedAt    OBR-22; observedAt OBR-7
 *   title       OBR-4.2
 */
export function mapOru(msg: Hl7Message): MappedDocument[] {
  return msg.segments.filter((s) => s.name === 'OBR').map((obr) => {
    const observer = following(msg, obr).map((obx) => mapXcn(obx, 16)).find((p) => p !== undefined);
    const interpreter = nonEmpty(comp(obr, 32, 1, 1));
    return defined({
      externalId: nonEmpty(comp(obr, 3, 1)) ?? nonEmpty(comp(obr, 2, 1)) ?? `${msg.header.controlId}-OBR`,
      kind: 'radiology_report' as const,
      status: ORU_STATUS[comp(obr, 25).trim().toUpperCase()] ?? 'preliminary',
      title: nonEmpty(comp(obr, 4, 2)),
      author: observer ?? (interpreter ? { npi: interpreter, lastName: comp(obr, 32, 1, 2), firstName: comp(obr, 32, 1, 3) } : undefined),
      signedAt: parseHl7DateTime(comp(obr, 22)),
      observedAt: parseHl7DateTime(comp(obr, 7)),
      ...obxBody(msg, obr),
    });
  });
}

/** The OBX segments after `header` up to the next header segment. */
const following = (msg: Hl7Message, header: Hl7Segment): Hl7Segment[] => {
  const out: Hl7Segment[] = [];
  for (const seg of msg.segments.slice(msg.segments.indexOf(header) + 1)) {
    if (HEADERS.has(seg.name)) break;
    if (seg.name === 'OBX') out.push(seg);
  }
  return out;
};

/**
 * Text of the OBX segments that follow `header`: OBX-2 TX|FT|ST repetitions of OBX-5 joined
 * with '\n' across segments; the first OBX-2 ED becomes the attachment (OBX-5.2 type,
 * OBX-5.3 subtype, OBX-5.5 base64 data).
 */
export function obxBody(msg: Hl7Message, header: Hl7Segment): Pick<MappedDocument, 'body' | 'attachment'> {
  const lines: string[] = [];
  let attachment: MappedDocument['attachment'];
  for (const obx of following(msg, header)) {
    const type = comp(obx, 2).trim().toUpperCase();
    if (TEXT_TYPES.has(type)) {
      lines.push(...reps(obx, 5).map((r) => repComp(r, 1)));
    } else if (type === 'ED' && !attachment) {
      const mediaType = [comp(obx, 5, 2), comp(obx, 5, 3)].map((s) => s.trim().toLowerCase()).filter((s) => s !== '').join('/');
      attachment = { mediaType: mediaType || 'application/octet-stream', base64: comp(obx, 5, 5) };
    }
  }
  return { body: lines.join('\n'), ...(attachment ? { attachment } : {}) };
}
