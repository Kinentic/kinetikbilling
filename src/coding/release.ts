// Release: the single hand-off from coding to billing, and QA review, which can complete it.

import { createHash } from 'node:crypto';
import { buildClaim, hasErrors, type BillingProviderConfig } from '../claims/index.ts';
import type { Store } from '../db/store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import type { ChargeDelta, ChargeId, Claim, CodingTask, CodingTaskId, IsoDateTime, ReleaseRecord, ScrubViolation } from '../domain/types.ts';
import { runCodingEdits } from './edits.ts';
import { chargesToCreate } from './plan.ts';
import { InvalidTaskTransitionError, requireTask, transitionTask } from './state.ts';
import { loadCodingContext, type CodingContext } from './workbench.ts';

export interface ReleaseDeps {
  billing: BillingProviderConfig;
  qaSamplePercent: number;
}

export interface ReleaseInput {
  coder: string;
  /** Reason the coder accepts the current warnings (SPEC 7.2). Required when any warning is present. */
  warningsAcknowledged?: string;
}

/** The claim side of the hand-off, run after the release transaction commits. */
export type ClaimHandoff =
  | { kind: 'built'; claim: Claim }
  /** buildClaim threw (no coverage, encounter gone, nothing billable). Charges stay unbilled; the release stands. */
  | { kind: 'not_built'; error: string };

/**
 * Outcome contract (decision 8). Refusals are values, not throws, so the route chooses
 * the status (blocked -> 422 with violations) and no caller can ignore them.
 */
export type ReleaseOutcome =
  /** Nothing written. Task unchanged (in_progress, or qa_review on a QA agree). */
  | { kind: 'blocked'; violations: ScrubViolation[] }
  /** in_progress -> coded -> qa_review committed; no charges yet. Also the answer to a repeat call while in QA. */
  | { kind: 'qa_review'; task: CodingTask }
  /** Charges written and task released in one transaction; claim hand-off attempted after. */
  | { kind: 'released'; task: CodingTask; releaseNumber: number; charges: ChargeDelta; claim: ClaimHandoff };

export type QaDecision =
  | { outcome: 'agree'; reviewer: string; notes?: string }
  | { outcome: 'return'; reviewer: string; notes: string };

/**
 * POST /coding/tasks/:id/release.
 *
 *  in_progress -> load context, run edits. Any error, or warnings without
 *                 warningsAcknowledged: blocked. Otherwise, one transaction:
 *                   transitionTask(coded, actor coder, detail { warnings, acknowledgement })
 *                   sampled(task, releaseNumber) ? transitionTask(qa_review) : enterReleased()
 *                 then, outside it, handOff().
 *  qa_review   -> { kind: 'qa_review', task }; no writes (repeat call).
 *  released    -> no writes to coding state; returns the last ReleaseRecord's number with
 *                 created/voided empty and kept = live charges, and re-runs handOff(). A
 *                 repeat call therefore retries a claim build that failed or never ran
 *                 (crash between the two transactions).
 *  otherwise   -> InvalidTaskTransitionError.
 *
 * Fee lookup failing for one line: fee-on-file error -> blocked; no line is released alone.
 * A crash anywhere inside the transaction rolls everything back; the task stays in_progress.
 */
export function release(store: Store, deps: ReleaseDeps, taskId: CodingTaskId, input: ReleaseInput, now: IsoDateTime = nowIso()): ReleaseOutcome {
  const task = requireTask(store, taskId);
  if (task.status === 'qa_review') return { kind: 'qa_review', task };
  if (task.status === 'released') return repeatRelease(store, deps.billing, task);
  if (task.status !== 'in_progress') throw new InvalidTaskTransitionError(taskId, task.status, 'coded');

  const ctx = loadCodingContext(store, taskId);
  const violations = runCodingEdits(ctx, deps.billing);
  const warnings = violations.filter((v) => v.severity === 'warning');
  if (hasErrors(violations) || (warnings.length > 0 && input.warningsAcknowledged === undefined)) return { kind: 'blocked', violations };

  const out = store.transaction((): Entered | { kind: 'qa_review'; task: CodingTask } => {
    const coded = transitionTask(store, task, 'coded', 'release requested', {
      actor: input.coder, at: now, detail: { warnings, ...(input.warningsAcknowledged === undefined ? {} : { acknowledgement: input.warningsAcknowledged }) },
    });
    const releaseNumber = releasesSoFar(store, taskId) + 1;
    if (sampled(taskId, releaseNumber, deps.qaSamplePercent)) return { kind: 'qa_review', task: transitionTask(store, coded, 'qa_review', 'sampled for QA review', { at: now }) };
    return enterReleased(store, ctx, coded, releaseNumber, input.coder, now);
  });
  return out.kind === 'qa_review' ? out : { ...out, claim: handOff(store, deps.billing, task) };
}

/**
 * POST /coding/tasks/:id/qa. Requires qa_review.
 *  agree  -> reload context and re-run edits (the fee schedule or a claim may have moved
 *            since `coded`); errors: blocked, task stays in qa_review. Else enterReleased()
 *            in one transaction, then handOff(). QA notes ride in the release record;
 *            a CodingAudit table is post-M1.
 *  return -> qa_review -> returned_to_coder with the notes. Returns { kind: 'returned', task }.
 */
export function reviewQa(store: Store, deps: ReleaseDeps, taskId: CodingTaskId, decision: QaDecision, now: IsoDateTime = nowIso()): ReleaseOutcome | { kind: 'returned'; task: CodingTask } {
  const task = requireTask(store, taskId);
  if (task.status !== 'qa_review') throw new InvalidTaskTransitionError(taskId, task.status, decision.outcome === 'agree' ? 'released' : 'returned_to_coder');
  if (decision.outcome === 'return') {
    return { kind: 'returned', task: transitionTask(store, task, 'returned_to_coder', 'returned by QA', { actor: decision.reviewer, at: now, detail: { notes: decision.notes } }) };
  }
  const ctx = loadCodingContext(store, taskId);
  const violations = runCodingEdits(ctx, deps.billing);
  if (hasErrors(violations)) return { kind: 'blocked', violations };
  const out = store.transaction(() => enterReleased(store, ctx, task, releasesSoFar(store, taskId) + 1, decision.reviewer, now, decision.notes));
  return { ...out, claim: handOff(store, deps.billing, task) };
}

// --- module-private (not exported from coding/index.ts) -----------------------------------

/** A release committed to coding state; the claim hand-off follows outside the transaction. */
type Entered = Omit<Extract<ReleaseOutcome, { kind: 'released' }>, 'claim'>;

const liveChargeIds = (store: Store, task: CodingTask): ChargeId[] =>
  store.listCharges({ encounterId: task.encounterId, source: 'coder' }).filter((c) => c.status !== 'voided').map((c) => c.id);

const releasesSoFar = (store: Store, taskId: CodingTaskId): number => store.listTaskEvents(taskId).filter((e) => e.to === 'released').length;

/** The retry path: nothing changes in coding state; the live charges are the kept set and the claim build runs again. */
const repeatRelease = (store: Store, billing: BillingProviderConfig, task: CodingTask): ReleaseOutcome => ({
  kind: 'released', task, releaseNumber: releasesSoFar(store, task.id), charges: { created: [], voided: [], kept: liveChargeIds(store, task) }, claim: handOff(store, billing, task),
});

/**
 * Inside the caller's transaction: void the plan's charges, insert the new ones, and move
 * the task to released with the ReleaseRecord (the full decided code set and the delta).
 */
function enterReleased(store: Store, ctx: CodingContext, task: CodingTask, releaseNumber: number, actor: string, now: IsoDateTime, qaNotes?: string): Entered {
  const { plan } = ctx;
  const created = chargesToCreate(plan, ctx.encounter.id, releaseNumber, newId<ChargeId>);
  store.voidCharges(plan.void.map((v) => v.charge.id), now);
  store.insertCoderCharges(created);
  const charges: ChargeDelta = { created: created.map((c) => c.id), voided: plan.void.map((v) => v.charge.id), kept: plan.lines.flatMap((l) => (l.keep ? [l.keep] : [])) };
  const record: ReleaseRecord = {
    releaseNumber, codeSet: ctx.codes.lines.filter((l) => !l.current.removed).map((l) => l.current), charges, ...(qaNotes === undefined ? {} : { qaNotes }),
  };
  const released = transitionTask(store, task, 'released', `release ${releaseNumber}`, { actor, at: now, detail: record });
  return { kind: 'released', task: released, releaseNumber, charges };
}

/** buildClaim in its own transaction; a throw becomes not_built. Idempotent: rebuilding with nothing new converges on the same claim. */
function handOff(store: Store, billing: BillingProviderConfig, task: CodingTask): ClaimHandoff {
  try {
    return { kind: 'built', claim: buildClaim(store, billing, task.encounterId) };
  } catch (e) {
    return { kind: 'not_built', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Deterministic sampling: first 32 bits of sha256(`${taskId}#${releaseNumber}`) mod 100 < percent. Replays decide the same way. */
function sampled(taskId: CodingTaskId, releaseNumber: number, percent: number): boolean {
  return createHash('sha256').update(`${taskId}#${releaseNumber}`).digest().readUInt32BE(0) % 100 < percent;
}
