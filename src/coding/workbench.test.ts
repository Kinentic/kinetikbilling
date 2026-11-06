import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cfg } from '../claims/testkit.ts';
import type { IsoDateTime } from '../domain/types.ts';
import { recordCernerProposals } from './codes.ts';
import { raiseQuery } from './queries.ts';
import { TaskNotFoundError } from './state.ts';
import { AT, cernerLine, doc, seedTask } from './testkit.ts';
import { TaskNotEditableError, editCodes, loadCodingContext, loadTaskView, readCodes, summarizeDocuments } from './workbench.ts';

test('readCodes lists the lines with the coding edits as release would see them; editCodes requires in_progress', () => {
  const s = seedTask('ready_to_code');
  recordCernerProposals(s.store, s.encounterId, [cernerLine('T1')], AT);
  const view = readCodes(s.store, cfg, s.task.id);
  assert.equal(view.lines.length, 2);
  assert.deepEqual(view.violations.filter((v) => v.rule === 'proposals-decided').map((v) => v.lineId).sort(), view.lines.map((l) => l.lineId).sort(), 'every pending proposal is a finding on its line');
  const line = view.lines[0]!;
  assert.throws(() => editCodes(s.store, cfg, s.task.id, 'coder-1', [{ op: 'accept', lineId: line.lineId, basedOn: line.current.id }], AT), TaskNotEditableError);

  const working = seedTask('in_progress');
  recordCernerProposals(working.store, working.encounterId, [cernerLine('T1')], AT);
  const before = readCodes(working.store, cfg, working.task.id);
  const after = editCodes(working.store, cfg, working.task.id, 'coder-1', before.lines.map((l) => ({ op: 'accept' as const, lineId: l.lineId, basedOn: l.current.id })), AT);
  assert.ok(after.lines.every((l) => !l.pending && l.history.length === 2));
  assert.deepEqual(after.violations.map((v) => v.rule), ['fee-on-file', 'rendering-provider'], 'decided, but unpriced and with no provider to render');
  assert.throws(() => readCodes(working.store, cfg, 'nope' as never), TaskNotFoundError);
});

test('summarizeDocuments groups versions into current plus prior versions, newest first', () => {
  const s = seedTask('ready_to_code');
  const v1 = doc(s.encounterId, { version: 1, status: 'preliminary', signedAt: '2026-11-01T10:00:00Z' as IsoDateTime });
  const v2 = doc(s.encounterId, { version: 2, signedAt: '2026-11-02T10:00:00Z' as IsoDateTime });
  const rad = doc(s.encounterId, { externalId: 'RAD1', kind: 'radiology_report', signedAt: '2026-11-03T10:00:00Z' as IsoDateTime });
  for (const d of [v1, v2, rad]) s.store.appendDocument(d);
  const summaries = summarizeDocuments(s.store.listDocuments(s.encounterId));
  assert.deepEqual(summaries.map((x) => [x.current.externalId, x.current.version, x.priorVersions.map((p) => p.version)]), [['RAD1', 1, []], ['DOC0001', 2, [1]]]);
  assert.deepEqual(summaries[1]!.priorVersions[0], { id: v1.id, version: 1, status: 'preliminary', recordedAt: v1.recordedAt });
  assert.deepEqual(loadCodingContext(s.store, s.task.id).documents.map((d) => d.id), [rad.id, v2.id]);
});

test('loadTaskView gathers the screen: patient, coverages, documents, codes, queries, events, overdue and QA flags', () => {
  const s = seedTask('awaiting_documentation', { documentationDueAt: '2026-11-10T18:15:00.000Z' as IsoDateTime });
  s.store.appendDocument(doc(s.encounterId, { status: 'preliminary' }));
  recordCernerProposals(s.store, s.encounterId, [cernerLine('T1')], AT);
  raiseQuery(s.store, s.task.id, { coder: 'coder-1', question: 'Where is the note?', channel: 'email' }, AT);
  const view = loadTaskView(s.store, cfg, s.task.id, '2026-11-11T00:00:00.000Z' as IsoDateTime);
  assert.equal(view.task.status, 'on_hold_query');
  assert.equal(view.patient.id, s.patientId);
  assert.equal(view.coverages.length, 1);
  assert.equal(view.documents.length, 1);
  assert.equal(view.codes.lines.length, 2);
  assert.equal(view.queries.length, 1);
  assert.deepEqual(view.events.map((e) => e.to), ['awaiting_documentation', 'on_hold_query']);
  assert.equal(view.qaSampled, false);
  assert.equal(view.documentationOverdue, false, 'on hold is not awaiting');

  const waiting = seedTask('awaiting_documentation', { documentationDueAt: '2026-11-10T18:15:00.000Z' as IsoDateTime });
  assert.equal(loadTaskView(waiting.store, cfg, waiting.task.id, '2026-11-10T19:00:00.000Z' as IsoDateTime).documentationOverdue, true);
  assert.equal(loadTaskView(waiting.store, cfg, waiting.task.id, '2026-11-08T19:00:00.000Z' as IsoDateTime).documentationOverdue, false);

  const qa = seedTask('qa_review');
  qa.store.recordTaskTransition(qa.task.id, 'coded', { taskId: qa.task.id, at: AT, from: 'in_progress', to: 'coded', reason: 'x' });
  qa.store.recordTaskTransition(qa.task.id, 'qa_review', { taskId: qa.task.id, at: AT, from: 'coded', to: 'qa_review', reason: 'sampled' });
  assert.equal(loadTaskView(qa.store, cfg, qa.task.id).qaSampled, true);
});
