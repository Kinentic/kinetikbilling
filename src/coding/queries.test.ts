import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderQueryId } from '../domain/types.ts';
import { QueryAlreadyAnsweredError, QueryNotFoundError, answerQuery, raiseQuery } from './queries.ts';
import { InvalidTaskTransitionError } from './state.ts';
import { AT, seedTask } from './testkit.ts';

const input = { coder: 'coder-1', question: 'Confirm total time for E/M level', channel: 'in_app' as const };

test('raising a query holds the task and stores the query; answering it resumes to in_progress', () => {
  const { store, task } = seedTask('in_progress');
  const held = raiseQuery(store, task.id, { ...input, sentTo: { npi: '1234567893', lastName: 'Smith', firstName: 'Robert' } }, AT);
  assert.equal(held.task.status, 'on_hold_query');
  assert.deepEqual(store.listQueries(task.id), [held.query]);
  assert.deepEqual([held.query.raisedBy, held.query.channel, held.query.sentAt, held.query.sentTo!.npi, held.query.answer], ['coder-1', 'in_app', AT, '1234567893', undefined]);
  assert.deepEqual(store.listTaskEvents(task.id).at(-1)!.actor, 'coder-1');
  assert.throws(() => raiseQuery(store, task.id, input, AT), InvalidTaskTransitionError, 'one open query at a time');
  assert.equal(store.listQueries(task.id).length, 1, 'the refused query was not stored');

  const answered = answerQuery(store, held.query.id, '22 minutes', AT);
  assert.equal(answered.task.status, 'in_progress');
  assert.deepEqual(answered.query.answer, { text: '22 minutes', at: AT });
  assert.deepEqual(store.getQuery(held.query.id)!.answer, { text: '22 minutes', at: AT });
  assert.deepEqual(store.listTaskEvents(task.id).at(-1)!.detail, { queryId: held.query.id });
});

test('the same answer again is a no-op; a different answer is refused; an unknown query is 404-shaped', () => {
  const { store, task } = seedTask('in_progress');
  const { query } = raiseQuery(store, task.id, input, AT);
  answerQuery(store, query.id, '22 minutes', AT);
  const events = store.listTaskEvents(task.id).length;
  const again = answerQuery(store, query.id, '22 minutes', AT);
  assert.equal(again.task.status, 'in_progress');
  assert.equal(store.listTaskEvents(task.id).length, events);
  assert.throws(() => answerQuery(store, query.id, '35 minutes', AT), QueryAlreadyAnsweredError);
  assert.throws(() => answerQuery(store, 'nope' as ProviderQueryId, 'x', AT), QueryNotFoundError);
});

test('a query can hold a task still awaiting documentation', () => {
  const { store, task } = seedTask('awaiting_documentation');
  assert.equal(raiseQuery(store, task.id, input, AT).task.status, 'on_hold_query');
  const released = seedTask('released');
  assert.throws(() => raiseQuery(released.store, released.task.id, input, AT), InvalidTaskTransitionError);
});
