import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStatus } from '../domain/types.ts';
import { InvalidTaskTransitionError, TASK_TRANSITIONS, TaskNotFoundError, requireTask, transitionTask } from './state.ts';
import { AT, seedTask } from './testkit.ts';

const ALL = Object.keys(TASK_TRANSITIONS) as TaskStatus[];

for (const from of ALL) {
  const illegal = ALL.filter((to) => !TASK_TRANSITIONS[from].includes(to));
  test(`${from}: every move outside the table throws and changes nothing`, () => {
    for (const to of illegal) {
      const { store, task } = seedTask(from);
      assert.throws(() => transitionTask(store, task, to, 'test'), (e: unknown) => e instanceof InvalidTaskTransitionError && e.from === from && e.to === to);
      assert.equal(store.getTask(task.id)!.status, from);
      assert.equal(store.listTaskEvents(task.id).length, 1);
    }
  });
  for (const to of TASK_TRANSITIONS[from]) {
    test(`${from} -> ${to} writes the status and the event together`, () => {
      const { store, task } = seedTask(from);
      const out = transitionTask(store, task, to, 'because', { actor: 'coder-1', detail: { k: 1 }, at: AT });
      assert.equal(out.status, to);
      assert.equal(store.getTask(task.id)!.status, to);
      assert.deepEqual(store.listTaskEvents(task.id).at(-1), { taskId: task.id, at: AT, from, to, reason: 'because', actor: 'coder-1', detail: { k: 1 } });
    });
  }
}

test('the stored status decides, not a stale in-memory copy', () => {
  const { store, task } = seedTask('ready_to_code');
  transitionTask(store, task, 'in_progress', 'started');
  assert.throws(() => transitionTask(store, task, 'in_progress', 'stale'), InvalidTaskTransitionError);
  assert.throws(() => requireTask(store, 'nope' as never), TaskNotFoundError);
});

test('every status reaches released through the table, and released can only reopen', () => {
  assert.deepEqual(TASK_TRANSITIONS.released, ['in_progress']);
  const reachable = new Set<TaskStatus>(['awaiting_documentation']);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of [...reachable]) for (const t of TASK_TRANSITIONS[s]) if (!reachable.has(t)) { reachable.add(t); changed = true; }
  }
  assert.deepEqual([...reachable].sort(), [...ALL].sort());
});
