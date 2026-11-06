// Coding-time edits in the ScrubRule shape (SPEC 7.2), over CodingContext. The smallest
// set that proves the shape; licensed content (NCCI, MUE, code validity) arrives with
// code set loading (M2) as more rows in the same table.

import { ICD10, OPEN, rule, when, type BillingProviderConfig, type ScrubRule } from '../claims/index.ts';
import type { CodeContent, ScrubViolation } from '../domain/types.ts';
import { activeCodes } from './codes.ts';
import type { CodingContext } from './workbench.ts';

/** The claims rule shape, generic over its context. Findings on a line carry lineId. */
export type CodingRule = ScrubRule<CodingContext>;

const describe = (c: CodeContent): string => (c.kind === 'procedure' ? `${c.code} on ${c.serviceDate}` : `diagnosis ${c.code}`);

export const CODING_RULES: readonly CodingRule[] = [
  rule('proposals-decided', 'error', (ctx) => ctx.codes.lines.filter((l) => l.pending).map((l) => ({ lineId: l.lineId, message: `${describe(l.current.content)} awaits a decision` }))),
  rule('procedure-present', 'error', (ctx) => when(activeCodes(ctx.codes).procedures.length === 0, 'no active procedure line')),
  rule('diagnosis-present', 'error', (ctx) => when(activeCodes(ctx.codes).diagnoses.length === 0, 'no active diagnosis line')),
  rule('diagnosis-icd10-shape', 'error', (ctx) => activeCodes(ctx.codes).diagnoses
    .filter((d) => !ICD10.test(d.code.code))
    .map((d) => ({ lineId: d.lineId, message: `diagnosis ${d.code.code} is not ICD-10 shaped` }))),
  rule('line-dx-resolved', 'error', (ctx) => ctx.plan.lines
    .filter((l) => l.unresolvedDiagnoses.length > 0)
    .map((l) => ({ lineId: l.lineId, message: `${l.procedure.code}: diagnosis ${l.unresolvedDiagnoses.join(', ')} is not in the active diagnosis set` }))),
  rule('line-dx-count', 'error', (ctx) => ctx.plan.lines
    .filter((l) => l.procedure.diagnosisCodes.length > 4)
    .map((l) => ({ lineId: l.lineId, message: `${l.procedure.code}: ${l.procedure.diagnosisCodes.length} diagnoses; the 837P line carries at most 4` }))),
  rule('claim-dx-count', 'error', (ctx) => when(ctx.plan.diagnoses.length > 12, `${ctx.plan.diagnoses.length} diagnoses; the 837P claim carries at most 12`)),
  rule('fee-on-file', 'error', (ctx) => ctx.plan.lines
    .filter((l) => l.unitFee === undefined)
    .map((l) => ({ lineId: l.lineId, message: `${l.procedure.code}${l.procedure.modifiers.length ? ` (${l.procedure.modifiers.join(', ')})` : ''}: no fee on file for ${l.procedure.serviceDate}` }))),
  rule('billed-claim-locked', 'error', (ctx) => ctx.plan.void
    .filter((v) => v.claims.some((c) => !OPEN.includes(c.status)))
    .map((v) => ({ chargeId: v.charge.id, message: `${v.charge.externalId}: charge sits on claim ${v.claims.filter((c) => !OPEN.includes(c.status)).map((c) => `${c.id} (${c.status})`).join(', ')}; corrected claims are a later milestone` }))),
  rule('rendering-provider', 'warning', (ctx) => ctx.plan.lines
    .filter((l) => l.renderingProvider === undefined)
    .map((l) => ({ lineId: l.lineId, message: `${l.procedure.code}: no rendering provider on the line, the latest final document, or the encounter` }))),
  rule('coverage-present', 'warning', (ctx) => when(!ctx.coverage, 'encounter has no priority-1 coverage; the claim build will fail')),
];

/** cfg is the billing identity rules compare NPIs against; none of the M1 rules read it, but the shared ScrubRule shape carries it. */
export const runCodingEdits = (ctx: CodingContext, cfg: BillingProviderConfig): ScrubViolation[] => CODING_RULES.flatMap((r) => r.check(ctx, cfg));
