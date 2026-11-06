// Minimal ProviderQuery (SPEC 5.3): raising one is the way a task goes on hold; answering
// it is the way it resumes. There is no separate /hold or /resume path.

import type { Store } from '../db/store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import type { CodingTask, CodingTaskId, IsoDateTime, Provider, ProviderQuery, ProviderQueryId, QueryChannel } from '../domain/types.ts';
import { requireTask, transitionTask } from './state.ts';

export interface RaiseQueryInput {
  coder: string;
  question: string;
  channel: QueryChannel;
  sentTo?: Provider;
}

export class QueryNotFoundError extends Error {
  constructor(id: ProviderQueryId) {
    super(`provider query not found: ${id}`);
    this.name = 'QueryNotFoundError';
  }
}

export class QueryAlreadyAnsweredError extends Error {
  constructor(id: ProviderQueryId) {
    super(`provider query ${id} already has a different answer`);
    this.name = 'QueryAlreadyAnsweredError';
  }
}

/**
 * in_progress | awaiting_documentation -> on_hold_query, with the query inserted in the
 * same transaction. A task holds on at most one open query: raising a second while on
 * hold is InvalidTaskTransitionError (on_hold_query -> on_hold_query is not in the table).
 */
export function raiseQuery(store: Store, taskId: CodingTaskId, input: RaiseQueryInput, at: IsoDateTime = nowIso()): { query: ProviderQuery; task: CodingTask } {
  const task = requireTask(store, taskId);
  return store.transaction(() => {
    const held = transitionTask(store, task, 'on_hold_query', 'provider query raised', { actor: input.coder, at });
    const query: ProviderQuery = {
      id: newId<ProviderQueryId>(), taskId, question: input.question, raisedBy: input.coder, channel: input.channel, sentAt: at,
      ...(input.sentTo ? { sentTo: input.sentTo } : {}),
    };
    store.insertQuery(query);
    return { query, task: held };
  });
}

/**
 * Records the answer and moves on_hold_query -> in_progress in one transaction. The same
 * answer again returns the current state with no writes; a different one is refused.
 * A code that came from the answer is added later with CodeEdit { op: 'add', queryId }.
 */
export function answerQuery(store: Store, queryId: ProviderQueryId, text: string, at: IsoDateTime = nowIso()): { query: ProviderQuery; task: CodingTask } {
  const query = store.getQuery(queryId);
  if (!query) throw new QueryNotFoundError(queryId);
  const task = requireTask(store, query.taskId);
  if (query.answer) {
    if (query.answer.text === text) return { query, task };
    throw new QueryAlreadyAnsweredError(queryId);
  }
  return store.transaction(() => {
    store.answerQuery(queryId, text, at);
    const resumed = transitionTask(store, task, 'in_progress', 'provider query answered', { at, detail: { queryId } });
    return { query: { ...query, answer: { text, at } }, task: resumed };
  });
}
