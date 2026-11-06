// Task lifecycle, mirroring claims/state.ts: one table, one writer, an event per move.

import type { Store } from '../db/store.ts';
import { nowIso } from '../domain/ids.ts';
import type { CodingTask, CodingTaskId, IsoDateTime, TaskStatus } from '../domain/types.ts';

/**
 * SPEC 7.1. Release moves in_progress -> coded -> (qa_review | released) in one transaction.
 * A reopen (route, corrected or new document) is released -> in_progress. New facts during
 * QA send qa_review -> returned_to_coder. A query raised while documentation is missing
 * holds from awaiting_documentation; its answer resumes to in_progress like any other hold.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  awaiting_documentation: ['ready_to_code', 'on_hold_query'],
  ready_to_code: ['in_progress'],
  in_progress: ['on_hold_query', 'coded'],
  on_hold_query: ['in_progress'],
  coded: ['qa_review', 'released'],
  qa_review: ['released', 'returned_to_coder'],
  returned_to_coder: ['in_progress'],
  released: ['in_progress'],
};

export class TaskNotFoundError extends Error {
  constructor(key: string) {
    super(`coding task not found: ${key}`);
    this.name = 'TaskNotFoundError';
  }
}

/** Distinct name from claims' InvalidTransitionError: the router maps by name. */
export class InvalidTaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  constructor(taskId: CodingTaskId, from: TaskStatus, to: TaskStatus) {
    super(`coding task ${taskId}: cannot move from ${from} to ${to}`);
    this.name = 'InvalidTaskTransitionError';
    this.from = from;
    this.to = to;
  }
}

export const canTransitionTask = (from: TaskStatus, to: TaskStatus): boolean => TASK_TRANSITIONS[from].includes(to);

export const requireTask = (store: Store, id: CodingTaskId): CodingTask => {
  const task = store.getTask(id);
  if (!task) throw new TaskNotFoundError(id);
  return task;
};

export interface TransitionOptions {
  actor?: string;
  detail?: unknown;
  at?: IsoDateTime;
}

/**
 * The only writer of task status. Re-reads the stored status (callers may hold a stale
 * copy), checks the table, and records status and event together. Throws
 * InvalidTaskTransitionError and never no-ops, so callers that want idempotence check
 * the status first.
 */
export const transitionTask = (store: Store, task: CodingTask, to: TaskStatus, reason: string, opts: TransitionOptions = {}): CodingTask => {
  const current = requireTask(store, task.id);
  if (!canTransitionTask(current.status, to)) throw new InvalidTaskTransitionError(task.id, current.status, to);
  const at = opts.at ?? nowIso();
  store.recordTaskTransition(task.id, to, {
    taskId: task.id, at, from: current.status, to, reason,
    ...(opts.actor === undefined ? {} : { actor: opts.actor }),
    ...(opts.detail === undefined ? {} : { detail: opts.detail }),
  });
  return { ...current, status: to, updatedAt: at };
};

/** A task's first event has from: null. Used only by coding/tasks.ts applyCodingFact. */
export const openTask = (store: Store, task: CodingTask, reason: string): CodingTask => {
  store.insertTask(task, { taskId: task.id, at: task.createdAt, from: null, to: task.status, reason });
  return task;
};
