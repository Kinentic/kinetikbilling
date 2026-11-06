// What a release would write, computed without writing. The coding edits validate this
// plan and release applies this plan, so what is checked is exactly what is written.

import type {
  Cents, ChargeDiagnosis, ChargeId, ClaimId, ClaimStatus, CodeAssignmentId, CodeLineId, CoderCharge, EncounterId, FeeScheduleLine, ProcedureCode, Provider,
} from '../domain/types.ts';
import type { ActiveCodes } from './codes.ts';
import { unitFee } from './fees.ts';

/** A coder charge that exists now and is not voided, with the claims it sits on. */
export interface LiveCharge {
  charge: CoderCharge;
  claims: readonly { id: ClaimId; status: ClaimStatus }[];
}

export interface PlannedLine {
  lineId: CodeLineId;
  assignmentId: CodeAssignmentId;
  /** The decided procedure content this line bills. */
  procedure: ProcedureCode;
  /** Undefined when no fee is on file; the fee-on-file edit blocks release. */
  unitFee?: Cents;
  amount?: Cents;
  /** The line's diagnosisCodes resolved by value against the active diagnosis set, in pointer order. */
  diagnoses: ChargeDiagnosis[];
  /** diagnosisCodes not in the active diagnosis set; the line-dx-resolved edit blocks release. */
  unresolvedDiagnoses: string[];
  renderingProvider?: Provider;
  /** Set when a live charge for this assignment already bills identical facts: kept, not recreated. */
  keep?: ChargeId;
}

export interface ReleasePlan {
  /** Active diagnoses renumbered 1..n in coder sequence; the sequences the lines carry by value. */
  diagnoses: ChargeDiagnosis[];
  lines: PlannedLine[];
  /** Live coder charges no current line keeps. */
  void: LiveCharge[];
}

export interface PlanInput {
  codes: ActiveCodes;
  schedule: readonly FeeScheduleLine[];
  live: readonly LiveCharge[];
  /** Author of the latest current final document, else the encounter's attending provider. */
  defaultRendering?: Provider;
}

/** The billed facts of a line: code, modifiers in order, units, service date, amount, diagnoses by code and sequence, performing NPI. */
const billedFacts = (p: { code: string; modifiers: readonly string[]; units: number; serviceDate: string; amount?: Cents; diagnoses: readonly ChargeDiagnosis[]; npi?: string }): string =>
  JSON.stringify([p.code, p.modifiers, p.units, p.serviceDate, p.amount, p.diagnoses.map((d) => [d.sequence, d.code]), p.npi]);

/**
 * Pure and total (never throws; gaps become undefined fields the edits report).
 * Keep rule: a live charge is kept iff its codeAssignmentId is a current procedure row
 * AND code, modifiers, units, serviceDate, amount, diagnoses (by value, in order) and
 * performing NPI all equal the planned values. Anything else voids the old charge and
 * creates a new one, so a diagnosis re-sequencing re-bills the affected lines.
 */
export function planRelease(input: PlanInput): ReleasePlan {
  const diagnoses: ChargeDiagnosis[] = input.codes.diagnoses.map(({ code }, i) => ({
    sequence: i + 1, code: code.code, codingSystem: 'ICD10', ...(code.description ? { description: code.description } : {}),
  }));
  const kept = new Set<ChargeId>();
  const lines = input.codes.procedures.map(({ lineId, assignmentId, code: procedure }): PlannedLine => {
    const fee = unitFee(input.schedule, procedure.code, procedure.modifiers, procedure.serviceDate);
    const amount = fee === undefined ? undefined : (fee * procedure.units) as Cents;
    const resolved = procedure.diagnosisCodes.map((c) => diagnoses.find((d) => d.code === c));
    const lineDiagnoses = resolved.filter((d): d is ChargeDiagnosis => d !== undefined);
    const renderingProvider = procedure.renderingProvider ?? input.defaultRendering;
    const facts = billedFacts({ ...procedure, amount, diagnoses: lineDiagnoses, npi: renderingProvider?.npi });
    const existing = input.live.find((l) => l.charge.codeAssignmentId === assignmentId && !kept.has(l.charge.id)
      && billedFacts({ ...l.charge, npi: l.charge.performingProvider?.npi }) === facts);
    if (existing) kept.add(existing.charge.id);
    return {
      lineId, assignmentId, procedure,
      ...(fee === undefined ? {} : { unitFee: fee, amount }),
      diagnoses: lineDiagnoses,
      unresolvedDiagnoses: procedure.diagnosisCodes.filter((_, i) => resolved[i] === undefined),
      ...(renderingProvider ? { renderingProvider } : {}),
      ...(existing ? { keep: existing.charge.id } : {}),
    };
  });
  return { diagnoses, lines, void: input.live.filter((l) => !kept.has(l.charge.id)) };
}

/** Materializes the plan's new charges. externalId = `${assignmentId}#${releaseNumber}`. Requires every created line priced. */
export function chargesToCreate(plan: ReleasePlan, encounterId: EncounterId, releaseNumber: number, newId: () => ChargeId): CoderCharge[] {
  return plan.lines.filter((l) => l.keep === undefined).map((l) => {
    if (l.amount === undefined) throw new Error(`line ${l.lineId} has no fee; the fee-on-file edit must run before release`);
    const { procedure } = l;
    return {
      id: newId(), encounterId, source: 'coder', codeAssignmentId: l.assignmentId, externalId: `${l.assignmentId}#${releaseNumber}`,
      transactionType: 'CG', serviceDate: procedure.serviceDate, codeSystem: procedure.codeSystem, code: procedure.code, modifiers: [...procedure.modifiers],
      units: procedure.units, amount: l.amount, diagnoses: l.diagnoses,
      ...(l.renderingProvider ? { performingProvider: l.renderingProvider } : {}),
    };
  });
}
