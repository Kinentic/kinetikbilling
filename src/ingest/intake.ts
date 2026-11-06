// The one place the billing mode is read (decision 6). Handlers are mode-agnostic: they
// map and upsert demographics, then hand the coding-relevant fact to the intake. The
// pass-through intake keeps v0.1 behaviour; the coder intake forwards each fact to one
// coding verb.

import { cernerLinesArrived, documentAppended, visitCompleted, type CernerLine, type CodingConfig } from '../coding/index.ts';
import type { Store } from '../db/store.ts';
import type { Encounter } from '../domain/types.ts';
import type { HandlerContext } from './handler.ts';
import type { MappedCharge } from './map/ft1.ts';
import { upsertCharges, type DocumentAppend } from './upsert.ts';

/** Each method returns summary fragments for the ACK/audit text. All run inside the handler transaction. */
export interface CodingIntake {
  /** After a document version was appended (or recognised as unchanged or stale). */
  onDocument(store: Store, encounter: Encounter, appended: DocumentAppend, ctx: HandlerContext): string[];
  /** The FT1 lines of a DFT^P03, already mapped. */
  onCharges(store: Store, encounter: Encounter, lines: readonly MappedCharge[], ctx: HandlerContext): string[];
  /** After A03 demographics, with dischargeAt as stored. */
  onDischarge(store: Store, encounter: Encounter, ctx: HandlerContext): string[];
}

const PASS_THROUGH: CodingIntake = {
  onDocument: () => [],
  onCharges(store, encounter, lines) {
    const { created, updated } = upsertCharges(store, encounter.id, lines);
    return [`${lines.length} charge${lines.length === 1 ? '' : 's'} (${created} new, ${updated} updated)`];
  },
  onDischarge: () => [],
};

/** The coder intake never writes charges and never touches the DG1 list. */
const coderIntake = (coding: CodingConfig): CodingIntake => ({
  onDocument: (store, encounter, appended, ctx) => documentAppended(store, encounter, appended, ctx.now),
  onCharges: (store, encounter, lines, ctx) => cernerLinesArrived(store, encounter, toCernerLines(lines), ctx, coding).summary,
  onDischarge: (store, encounter, ctx) => visitCompleted(store, encounter, ctx, coding),
});

export const intakeFor = (coding: CodingConfig): CodingIntake => (coding.mode === 'pass_through' ? PASS_THROUGH : coderIntake(coding));

/** MappedCharge -> CernerLine: FT1-6 CD becomes reversal; FT1-19 refs become diagnosis codes. Pure. */
export const toCernerLines = (lines: readonly MappedCharge[]): CernerLine[] => lines.map((l) => ({
  sourceRef: l.externalId,
  reversal: l.transactionType === 'CD',
  procedure: {
    kind: 'procedure', codeSystem: l.codeSystem, code: l.code, modifiers: l.modifiers, units: l.units, serviceDate: l.serviceDate,
    ...(l.performingProvider ? { renderingProvider: l.performingProvider } : {}),
    diagnosisCodes: l.diagnosisRefs.map((d) => d.code),
  },
  diagnoses: l.diagnosisRefs.map((d) => ({ code: d.code, ...(d.description ? { description: d.description } : {}) })),
}));
