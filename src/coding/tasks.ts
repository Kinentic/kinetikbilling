// Task creation and every feed-driven or person-driven move that is not release, QA, or a
// query. The decision-5 matrix is one pure function, reactToFact.

import { OPEN, draftClaim } from '../claims/index.ts';
import type { Store } from '../db/store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import type {
  CodingTask, CodingTaskId, Document, Encounter, EncounterId, IsoDateTime, MessageId, Specialty, TaskOrigin, TaskStatus,
} from '../domain/types.ts';
import type { DocumentAppend } from '../ingest/upsert.ts';
import { recordCernerProposals, type CernerLine, type ProposalOutcome } from './codes.ts';
import type { CodingConfig } from './config.ts';
import { openTask, requireTask, transitionTask } from './state.ts';

/** Something a feed told us that may create or move the encounter's task. */
export type CodingFact =
  /** A final or corrected version was appended (not an identical redelivery). */
  | { kind: 'final_document'; document: Document; correction: boolean }
  /** ADT^A03 in coder mode. dueAt = dischargeAt (or now) + documentationGraceHours. */
  | { kind: 'discharge'; messageId: MessageId; dueAt: IsoDateTime }
  /** DFT^P03 appended at least one new proposal row (identical replays append none and raise no fact). */
  | { kind: 'proposals'; messageId: MessageId; appended: number; dueAt: IsoDateTime };

export type TaskReaction =
  | { kind: 'create'; status: 'ready_to_code' | 'awaiting_documentation'; origin: TaskOrigin; reason: string; documentationDueAt?: IsoDateTime; specialty?: Specialty }
  | { kind: 'transition'; to: TaskStatus; reason: string; specialty?: Specialty }
  | { kind: 'none'; reason: string; specialty?: Specialty };

export const specialtyOf = (doc: Document): Specialty => (doc.kind === 'radiology_report' ? 'radiology' : 'primary_care');

const documentReason = (fact: Extract<CodingFact, { kind: 'final_document' }>): string => (fact.correction ? 'document corrected' : 'final document received');

/** Statuses that react alike: the coder is working, or the task sits in QA, or it is released. */
type Phase = 'awaiting' | 'working' | 'qa' | 'released';
const PHASE: Record<TaskStatus, Phase> = {
  awaiting_documentation: 'awaiting',
  ready_to_code: 'working',
  in_progress: 'working',
  on_hold_query: 'working',
  returned_to_coder: 'working',
  coded: 'qa',
  qa_review: 'qa',
  released: 'released',
};

type Reactor<K extends CodingFact['kind']> = (fact: Extract<CodingFact, { kind: K }>) => TaskReaction;
const MATRIX: { [K in CodingFact['kind']]: Record<Phase, Reactor<K>> } = {
  final_document: {
    awaiting: (f) => ({ kind: 'transition', to: 'ready_to_code', reason: documentReason(f), specialty: specialtyOf(f.document) }),
    working: (f) => ({ kind: 'none', reason: 'document visible to the coder', specialty: specialtyOf(f.document) }),
    qa: (f) => ({ kind: 'transition', to: 'returned_to_coder', reason: `${documentReason(f)} during QA`, specialty: specialtyOf(f.document) }),
    released: (f) => ({ kind: 'transition', to: 'in_progress', reason: f.correction ? 'document corrected' : 'new document after release', specialty: specialtyOf(f.document) }),
  },
  discharge: {
    awaiting: () => ({ kind: 'none', reason: 'task already awaiting documentation' }),
    working: () => ({ kind: 'none', reason: 'task already open' }),
    qa: () => ({ kind: 'none', reason: 'task in QA' }),
    released: () => ({ kind: 'none', reason: 'task released' }),
  },
  proposals: {
    awaiting: () => ({ kind: 'none', reason: 'proposals pending on the task' }),
    working: () => ({ kind: 'none', reason: 'proposals pending; release waits for a decision' }),
    qa: () => ({ kind: 'transition', to: 'returned_to_coder', reason: 'Cerner charges arrived during QA' }),
    released: () => ({ kind: 'none', reason: 'proposals pending after release; a person reopens' }),
  },
};

const CREATE: { [K in CodingFact['kind']]: Reactor<K> } = {
  final_document: (f) => ({
    kind: 'create', status: 'ready_to_code', origin: { kind: 'document', documentId: f.document.id }, reason: documentReason(f), specialty: specialtyOf(f.document),
  }),
  discharge: (f) => ({ kind: 'create', status: 'awaiting_documentation', origin: { kind: 'discharge', messageId: f.messageId }, reason: 'visit completed without documentation', documentationDueAt: f.dueAt }),
  proposals: (f) => ({ kind: 'create', status: 'awaiting_documentation', origin: { kind: 'dft', messageId: f.messageId }, reason: 'Cerner charges arrived without documentation', documentationDueAt: f.dueAt }),
};

/**
 * Decision 5, total over (task status x fact). Pure; tested as a table.
 *
 * | fact \ task      | none                         | awaiting_documentation | ready/in_progress/hold/returned | qa_review (coded*)          | released                         |
 * |------------------|------------------------------|------------------------|---------------------------------|-----------------------------|----------------------------------|
 * | final_document   | create ready_to_code         | -> ready_to_code       | none (document visible)         | -> returned_to_coder        | -> in_progress (reopen)          |
 * | discharge        | create awaiting (dueAt)      | none                   | none                            | none                        | none                             |
 * | proposals        | create awaiting (dueAt)      | none                   | none (pending; blocks release)  | -> returned_to_coder        | none (annotate; a person reopens)|
 *
 * (*) coded is never at rest; treated as qa_review defensively.
 * Late Cerner charges after release do not reopen by themselves, because lab lines trickle
 * in and would bounce a released claim; the proposals wait as pending rows, visible on the
 * task, and block the next release until decided. A preliminary document is never a fact.
 * Specialty rides along on any final_document reaction and is written only when the task
 * has none yet. Coverage is not a readiness input (SPEC 7.1 deviation, design.md).
 */
export function reactToFact(task: CodingTask | undefined, fact: CodingFact): TaskReaction {
  if (!task) return (CREATE[fact.kind] as Reactor<typeof fact.kind>)(fact);
  return (MATRIX[fact.kind][PHASE[task.status]] as Reactor<typeof fact.kind>)(fact);
}

/**
 * A reopen parks the task's open claims: draftClaim for every OPEN claim holding a live
 * coder charge of this encounter, so the stale claim cannot be submitted before the next
 * release rebuilds it. Charges themselves are untouched until that release.
 */
const parkOpenClaims = (store: Store, encounterId: EncounterId, reason: string): void => {
  for (const claim of store.listClaims({ encounterId })) {
    if (!OPEN.includes(claim.status)) continue;
    if (store.listCharges({ claimId: claim.id }).some((c) => c.source === 'coder' && c.status !== 'voided')) draftClaim(store, claim.id, reason);
  }
};

/**
 * Applies reactToFact for the encounter's task. Runs inside the handler's transaction, so a
 * crash leaves the fact and its document or proposals uncommitted together. Returns a summary
 * fragment for the ingest audit. Module-private: the three ingest-facing verbs are its callers.
 */
function applyCodingFact(store: Store, encounterId: EncounterId, fact: CodingFact, at: IsoDateTime): string {
  const task = store.findTaskByEncounter(encounterId);
  const reaction = reactToFact(task, fact);
  if (reaction.kind === 'create') {
    const created: CodingTask = {
      id: newId<CodingTaskId>(), encounterId, status: reaction.status, origin: reaction.origin, createdAt: at, updatedAt: at,
      ...(reaction.specialty ? { specialty: reaction.specialty } : {}),
      ...(reaction.documentationDueAt ? { documentationDueAt: reaction.documentationDueAt } : {}),
    };
    openTask(store, created, reaction.reason);
    return `task created ${created.status}`;
  }
  if (reaction.specialty && !task!.specialty) store.setTaskSpecialty(task!.id, reaction.specialty, at);
  if (reaction.kind === 'none') return `task ${task!.status} (${reaction.reason})`;
  transitionTask(store, task!, reaction.to, reaction.reason, { at });
  if (task!.status === 'released' && reaction.to === 'in_progress') parkOpenClaims(store, encounterId, reaction.reason);
  return `task ${reaction.to}`;
}

// Ingest-facing verbs: the coder intake calls exactly one per message. Each records what the
// feed said and applies the resulting fact in the same transaction.

/** A document version outcome from appendDocumentVersion. A new or new_version final or corrected document raises final_document. */
export function documentAppended(store: Store, encounter: Encounter, appended: DocumentAppend, at: IsoDateTime): string[] {
  if (appended.outcome !== 'new' && appended.outcome !== 'new_version') return [];
  const { document, prior } = appended;
  if (document.status === 'preliminary') return [];
  const correction = document.status === 'corrected' || (prior !== undefined && prior.status !== 'preliminary');
  return [applyCodingFact(store, encounter.id, { kind: 'final_document', document, correction }, at)];
}

const dueAt = (encounter: Encounter, now: IsoDateTime, coding: CodingConfig): IsoDateTime => addHours(encounter.dischargeAt ?? now, coding.documentationGraceHours);

/** Records the proposals, then raises the proposals fact when anything was appended. */
export function cernerLinesArrived(store: Store, encounter: Encounter, lines: readonly CernerLine[], ctx: { now: IsoDateTime; messageId: MessageId }, coding: CodingConfig): { outcome: ProposalOutcome; summary: string[] } {
  const outcome = recordCernerProposals(store, encounter.id, lines, ctx.now);
  const summary = [`${outcome.appended} proposal${outcome.appended === 1 ? '' : 's'} appended, ${outcome.unchanged} unchanged`];
  if (outcome.unmatchedCredits.length > 0) summary.push(`credits without a charge line: ${outcome.unmatchedCredits.join(' ')}`);
  if (outcome.appended > 0) {
    summary.push(applyCodingFact(store, encounter.id, { kind: 'proposals', messageId: ctx.messageId, appended: outcome.appended, dueAt: dueAt(encounter, ctx.now, coding) }, ctx.now));
  }
  return { outcome, summary };
}

/** The discharge fact with dueAt = (encounter.dischargeAt ?? now) + coding.documentationGraceHours. */
export function visitCompleted(store: Store, encounter: Encounter, ctx: { now: IsoDateTime; messageId: MessageId }, coding: CodingConfig): string[] {
  return [applyCodingFact(store, encounter.id, { kind: 'discharge', messageId: ctx.messageId, dueAt: dueAt(encounter, ctx.now, coding) }, ctx.now)];
}

/** Lead assignment. Not a status change; writes assignee only. */
export function assignTask(store: Store, taskId: CodingTaskId, assignee: string, at: IsoDateTime = nowIso()): CodingTask {
  requireTask(store, taskId);
  store.setTaskAssignee(taskId, assignee, at);
  return requireTask(store, taskId);
}

export class TaskAssignedElsewhereError extends Error {
  constructor(taskId: CodingTaskId, assignee: string) {
    super(`coding task ${taskId} is assigned to ${assignee}`);
    this.name = 'TaskAssignedElsewhereError';
  }
}

/**
 * ready_to_code | returned_to_coder -> in_progress. An unassigned task is assigned to
 * `coder` first (self-pull); a task assigned to someone else is refused. Calling it on a
 * task already in_progress for the same coder returns the task unchanged.
 */
export function startTask(store: Store, taskId: CodingTaskId, coder: string, at: IsoDateTime = nowIso()): CodingTask {
  const task = requireTask(store, taskId);
  if (task.assignee !== undefined && task.assignee !== coder) throw new TaskAssignedElsewhereError(taskId, task.assignee);
  if (task.status === 'in_progress' && task.assignee === coder) return task;
  return store.transaction(() => {
    if (task.assignee === undefined) store.setTaskAssignee(taskId, coder, at);
    return transitionTask(store, task, 'in_progress', 'coding started', { actor: coder, at });
  });
}

/** released -> in_progress by a person (denial for a coding reason, lead decision). Parks open claims as draft; charges wait for the next release. */
export function reopenTask(store: Store, taskId: CodingTaskId, reason: string, actor?: string): CodingTask {
  const task = requireTask(store, taskId);
  return store.transaction(() => {
    const reopened = transitionTask(store, task, 'in_progress', reason, actor === undefined ? {} : { actor });
    parkOpenClaims(store, task.encounterId, reason);
    return reopened;
  });
}

/** Pure clock helper; keeps date math out of handlers. */
export const addHours = (t: IsoDateTime, hours: number): IsoDateTime => new Date(Date.parse(t) + hours * 3_600_000).toISOString() as IsoDateTime;
