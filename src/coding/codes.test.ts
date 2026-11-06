import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seed } from '../claims/testkit.ts';
import type { CodeAssignment, CodeAssignmentId, CodeLineId, EncounterId, IsoDate, ProviderQueryId } from '../domain/types.ts';
import {
  CodeLineNotFoundError, StaleCodeLineError, activeCodes, deriveCodeSet, planCernerProposals, planCoderEdits, recordCernerProposals, recordCoderEdits,
  type CodeEdit, type CodeSet,
} from './codes.ts';
import { AT, cernerLine } from './testkit.ts';

const E1 = 'E1' as EncounterId;
let n = 0;
const row = (lineId: string, extra: Partial<CodeAssignment> = {}): CodeAssignment => ({
  id: `A${++n}` as CodeAssignmentId, encounterId: E1, lineId: lineId as CodeLineId, removed: false, provenance: 'coder', recordedAt: AT,
  content: { kind: 'diagnosis', code: 'I10', sequence: 1 }, decision: { by: 'coder-1', at: AT }, ...extra,
});
const procedure = (code = '99213', extra = {}) => ({ kind: 'procedure' as const, codeSystem: 'CPT' as const, code, modifiers: [] as string[], units: 1, serviceDate: '2026-11-05' as IsoDate, diagnosisCodes: ['I10'], ...extra });
const dx = (code: string, sequence: number) => ({ kind: 'diagnosis' as const, code, sequence });
const apply = (set: CodeSet, rows: CodeAssignment[]): CodeSet => deriveCodeSet([...set.lines.flatMap((l) => l.history), ...rows]);
const empty: CodeSet = { lines: [] };

test('deriveCodeSet folds supersedes chains into lines with history, current and pending', () => {
  const a = row('L1', { provenance: 'cerner_dft', sourceRef: 'T1', decision: undefined, content: procedure() });
  delete a.decision;
  const b = row('L1', { supersedes: a.id, provenance: 'cerner_dft', sourceRef: 'T1', content: procedure() });
  const c = row('L2', { content: dx('I10', 2) });
  const d = row('L3', { content: dx('E11.9', 1) });
  const e = row('L3', { supersedes: d.id, removed: true, content: dx('E11.9', 1) });
  const set = deriveCodeSet([a, b, c, d, e]);
  assert.deepEqual(set.lines.map((l) => [l.lineId, l.current.id, l.history.map((h) => h.id), l.pending]), [['L1', b.id, [a.id, b.id], false], ['L2', c.id, [c.id], false], ['L3', e.id, [d.id, e.id], false]]);
  assert.equal(deriveCodeSet([a]).lines[0]!.pending, true);
  const active = activeCodes(set);
  assert.deepEqual(active.procedures.map((p) => [p.lineId, p.assignmentId, p.code.code]), [['L1', b.id, '99213']]);
  assert.deepEqual(active.diagnoses.map((x) => x.code.code), ['I10'], 'a removed line and a pending line are not active');
  assert.deepEqual(activeCodes(deriveCodeSet([a, c])).procedures, [], 'a pending proposal is not active');
});

test('activeCodes orders diagnoses by sequence, not log order', () => {
  const set = deriveCodeSet([row('L1', { content: dx('I10', 2) }), row('L2', { content: dx('E11.9', 1) })]);
  assert.deepEqual(activeCodes(set).diagnoses.map((d) => d.code.code), ['E11.9', 'I10']);
});

test('planCoderEdits: add, change, remove and accept append the expected rows and normalize content', () => {
  const proposal = row('L1', { provenance: 'cerner_dft', sourceRef: 'T1', content: procedure('99213', { modifiers: [' 25 ', ''], diagnosisCodes: ['i10', 'I10'] }) });
  delete proposal.decision;
  const set = deriveCodeSet([proposal]);
  const edits: CodeEdit[] = [
    { op: 'accept', lineId: proposal.lineId, basedOn: proposal.id },
    { op: 'add', content: dx(' i10', 1) },
    { op: 'add', content: dx('E11.9', 2), queryId: 'Q1' as ProviderQueryId },
  ];
  const rows = planCoderEdits(set, E1, 'coder-1', edits, AT);
  assert.equal(rows.length, 3);
  const [accepted, added, fromQuery] = rows;
  assert.deepEqual([accepted!.lineId, accepted!.supersedes, accepted!.provenance, accepted!.sourceRef, accepted!.removed], ['L1', proposal.id, 'cerner_dft', 'T1', false]);
  assert.deepEqual(accepted!.decision, { by: 'coder-1', at: AT });
  assert.deepEqual(accepted!.content, proposal.content, 'accept keeps the proposed content as written');
  assert.deepEqual([added!.provenance, added!.content, added!.supersedes], ['coder', dx('I10', 1), undefined]);
  assert.deepEqual([fromQuery!.provenance, fromQuery!.decision], ['provider_query', { by: 'coder-1', at: AT, queryId: 'Q1' }]);

  const after = apply(set, rows);
  const current = after.lines[0]!.current;
  const changed = planCoderEdits(after, E1, 'coder-1', [{ op: 'change', lineId: current.lineId, basedOn: current.id, content: procedure('99214', { modifiers: ['25', ' 95'], diagnosisCodes: ['i10', 'e11.9', 'I10'] }) }], AT);
  assert.deepEqual(changed[0]!.content, procedure('99214', { modifiers: ['25', '95'], diagnosisCodes: ['I10', 'E11.9'] }));
  assert.equal(changed[0]!.provenance, 'coder');
  assert.equal(changed[0]!.sourceRef, undefined);

  const final = apply(after, changed);
  const removed = planCoderEdits(final, E1, 'coder-2', [{ op: 'remove', lineId: 'L1' as CodeLineId, basedOn: changed[0]!.id }], AT);
  assert.deepEqual([removed[0]!.removed, removed[0]!.content, removed[0]!.decision!.by], [true, changed[0]!.content, 'coder-2']);
  assert.deepEqual(activeCodes(apply(final, removed)).procedures, []);
});

test('planCoderEdits: a stale basedOn or an unknown line is refused, and accepting a decided row appends nothing', () => {
  const a = row('L1', { content: procedure() });
  const b = row('L1', { supersedes: a.id, content: procedure('99214') });
  const set = deriveCodeSet([a, b]);
  assert.throws(() => planCoderEdits(set, E1, 'c', [{ op: 'change', lineId: 'L1' as CodeLineId, basedOn: a.id, content: procedure() }], AT), StaleCodeLineError);
  assert.throws(() => planCoderEdits(set, E1, 'c', [{ op: 'remove', lineId: 'L9' as CodeLineId, basedOn: a.id }], AT), CodeLineNotFoundError);
  assert.deepEqual(planCoderEdits(set, E1, 'c', [{ op: 'accept', lineId: 'L1' as CodeLineId, basedOn: b.id }], AT), []);
  assert.throws(() => planCoderEdits(set, E1, 'c', [
    { op: 'change', lineId: 'L1' as CodeLineId, basedOn: b.id, content: procedure('99215') },
    { op: 'remove', lineId: 'L1' as CodeLineId, basedOn: b.id },
  ], AT), StaleCodeLineError, 'within one batch each edit sees the rows before it');
});

test('planCernerProposals: new lines are pending; identical content appends nothing; changed content supersedes', () => {
  const first = planCernerProposals(empty, [], E1, [cernerLine('T1')], AT);
  assert.equal(first.rows.length, 2);
  const [proc, diag] = first.rows;
  assert.deepEqual([proc!.provenance, proc!.sourceRef, proc!.removed, proc!.decision, proc!.content.kind], ['cerner_dft', 'T1', false, undefined, 'procedure']);
  assert.deepEqual(diag!.content, { kind: 'diagnosis', code: 'R07.9', sequence: 1, description: 'Chest pain, unspecified' });
  assert.equal(diag!.sourceRef, 'dx:R07.9');

  const set = deriveCodeSet(first.rows);
  assert.deepEqual(planCernerProposals(set, first.rows, E1, [cernerLine('T1')], AT), { rows: [], unmatchedCredits: [] });

  const corrected = planCernerProposals(set, first.rows, E1, [cernerLine('T1', { procedure: { ...cernerLine('T1').procedure, units: 2 } })], AT);
  assert.equal(corrected.rows.length, 1);
  assert.deepEqual([corrected.rows[0]!.lineId, corrected.rows[0]!.supersedes, corrected.rows[0]!.decision], [proc!.lineId, proc!.id, undefined]);
  assert.equal((corrected.rows[0]!.content as { units: number }).units, 2);
});

test('planCernerProposals: a coder\'s change survives a redelivery, and a changed FT1 proposes over the coder\'s row', () => {
  const first = planCernerProposals(empty, [], E1, [cernerLine('T1')], AT);
  const rows = [...first.rows];
  const edited = planCoderEdits(deriveCodeSet(rows), E1, 'coder-1', [{ op: 'change', lineId: first.rows[0]!.lineId, basedOn: first.rows[0]!.id, content: procedure('99214') }], AT);
  rows.push(...edited);
  const set = deriveCodeSet(rows);
  assert.deepEqual(planCernerProposals(set, rows, E1, [cernerLine('T1')], AT).rows, [], 'the same FT1 again compares against its own last row, not the coder\'s');
  assert.equal(set.lines[0]!.current.content.kind === 'procedure' && set.lines[0]!.current.content.code, '99214');

  const changed = planCernerProposals(set, rows, E1, [cernerLine('T1', { procedure: { ...cernerLine('T1').procedure, modifiers: ['95'] } })], AT);
  assert.equal(changed.rows.length, 1);
  assert.equal(changed.rows[0]!.supersedes, edited[0]!.id, 'Cerner\'s correction supersedes the line\'s current row');
  assert.equal(deriveCodeSet([...rows, ...changed.rows]).lines[0]!.pending, true);
});

test('planCernerProposals: a CD retracts the matching CG line once; an unmatched CD is reported; FT1-19 proposes a diagnosis once', () => {
  const cg = cernerLine('T2', { procedure: procedure('36415'), diagnoses: [{ code: 'R07.9' }] });
  const cd = cernerLine('T3', { reversal: true, procedure: procedure('36415'), diagnoses: [{ code: 'R07.9' }, { code: 'Z00.00' }] });
  const out = planCernerProposals(empty, [], E1, [cg, cd], AT);
  assert.deepEqual(out.unmatchedCredits, []);
  const [proc, diag, removal] = out.rows;
  assert.deepEqual([removal!.lineId, removal!.supersedes, removal!.removed, removal!.sourceRef, removal!.content], [proc!.lineId, proc!.id, true, 'T3', proc!.content]);
  assert.deepEqual(out.rows.map((r) => r.sourceRef), ['T2', 'dx:R07.9', 'T3'], 'a credit line does not propose diagnoses');
  assert.equal(diag!.content.kind, 'diagnosis');

  const rows = out.rows;
  const set = deriveCodeSet(rows);
  assert.deepEqual(planCernerProposals(set, rows, E1, [cg, cd], AT).rows, [], 'the redelivered CG compares equal and the CD was seen');
  const other = planCernerProposals(set, rows, E1, [cernerLine('T4', { reversal: true, procedure: procedure('99213') })], AT);
  assert.deepEqual(other, { rows: [], unmatchedCredits: ['T4'] });

  const more = planCernerProposals(set, rows, E1, [cernerLine('T5', { procedure: procedure('99213', { diagnosisCodes: ['R07.9', 'I10'] }), diagnoses: [{ code: 'R07.9' }, { code: 'I10' }] })], AT);
  assert.deepEqual(more.rows.map((r) => [r.sourceRef, r.content.kind === 'diagnosis' ? r.content.sequence : undefined]), [['T5', undefined], ['dx:I10', 2]], 'R07.9 already has a dx row; I10 takes the next sequence');
});

test('a removed diagnosis proposal is not proposed again, and a coder-added diagnosis counts as active', () => {
  const first = planCernerProposals(empty, [], E1, [cernerLine('T1')], AT);
  const dxRow = first.rows[1]!;
  const rows = [...first.rows, ...planCoderEdits(deriveCodeSet(first.rows), E1, 'c', [
    { op: 'remove', lineId: dxRow.lineId, basedOn: dxRow.id },
    { op: 'add', content: dx('I10', 1) },
  ], AT)];
  const again = planCernerProposals(deriveCodeSet(rows), rows, E1, [cernerLine('T6', { procedure: procedure('36415'), diagnoses: [{ code: 'R07.9' }, { code: 'I10' }] })], AT);
  assert.deepEqual(again.rows.map((r) => r.sourceRef), ['T6']);
});

test('recordCernerProposals and recordCoderEdits append through the Store and report counts', () => {
  const s = seed();
  const out = recordCernerProposals(s.store, s.encounterId, [cernerLine('T1'), cernerLine('T2', { procedure: procedure('36415') }), cernerLine('T3', { reversal: true, procedure: procedure('36415') })], AT);
  assert.deepEqual(out, { appended: 4, unchanged: 0, unmatchedCredits: [] });
  assert.deepEqual(recordCernerProposals(s.store, s.encounterId, [cernerLine('T1'), cernerLine('T9', { reversal: true, procedure: procedure('71046') })], AT), { appended: 0, unchanged: 1, unmatchedCredits: ['T9'] });
  const set = deriveCodeSet(s.store.listCodeAssignments(s.encounterId));
  assert.equal(set.lines.length, 3);
  const edited = recordCoderEdits(s.store, s.encounterId, 'coder-1', set.lines.map((l) => ({ op: 'accept' as const, lineId: l.lineId, basedOn: l.current.id })), AT);
  assert.ok(edited.lines.every((l) => !l.pending));
  assert.equal(s.store.listCodeAssignments(s.encounterId).length, 7);
  assert.throws(() => recordCoderEdits(s.store, s.encounterId, 'coder-1', [{ op: 'remove', lineId: set.lines[0]!.lineId, basedOn: set.lines[0]!.current.id }], AT), StaleCodeLineError);
  assert.equal(s.store.listCodeAssignments(s.encounterId).length, 7, 'a refused batch writes nothing');
});
