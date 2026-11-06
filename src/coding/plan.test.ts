import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cents, type ChargeId, type CodeAssignmentId, type CodeLineId, type CoderCharge, type DiagnosisCode, type EncounterId, type FeeScheduleLine, type IsoDate, type ProcedureCode,
  type Provider,
} from '../domain/types.ts';
import type { ActiveCodes } from './codes.ts';
import { chargesToCreate, planRelease, type LiveCharge, type PlanInput } from './plan.ts';

const E1 = 'E1' as EncounterId;
const SMITH: Provider = { npi: '1234567893', lastName: 'Smith', firstName: 'Robert' };
const JONES: Provider = { npi: '2222222226', lastName: 'Jones', firstName: 'Anna' };
const SCHEDULE: FeeScheduleLine[] = [
  { code: '99213', modifiers: [], amount: cents(12500), effectiveFrom: '2026-01-01' as IsoDate },
  { code: '71046', modifiers: ['26'], amount: cents(9000), effectiveFrom: '2026-01-01' as IsoDate },
];
const procedure = (code: string, extra: Partial<ProcedureCode> = {}): ProcedureCode =>
  ({ kind: 'procedure', codeSystem: 'CPT', code, modifiers: [], units: 1, serviceDate: '2026-10-02' as IsoDate, diagnosisCodes: ['R07.9'], ...extra });
const dx = (code: string, sequence: number, description?: string): DiagnosisCode => ({ kind: 'diagnosis', code, sequence, ...(description ? { description } : {}) });
const codes = (procedures: [string, ProcedureCode][], diagnoses: DiagnosisCode[]): ActiveCodes => ({
  procedures: procedures.map(([id, code]) => ({ lineId: `L${id}` as CodeLineId, assignmentId: `A${id}` as CodeAssignmentId, code })),
  diagnoses: diagnoses.map((code, i) => ({ lineId: `LD${i}` as CodeLineId, assignmentId: `AD${i}` as CodeAssignmentId, code })),
});
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  codes: codes([['1', procedure('99213')]], [dx('R07.9', 1, 'Chest pain')]), schedule: SCHEDULE, live: [], defaultRendering: SMITH, ...over,
});
let n = 0;
const nextId = (): ChargeId => `C${++n}` as ChargeId;
const live = (charge: CoderCharge, status: LiveCharge['claims'][number]['status'] = 'ready'): LiveCharge => ({ charge, claims: [{ id: 'K1' as never, status }] });

test('planRelease prices each line from the schedule with modifier fallback and units, and leaves unpriced lines undefined', () => {
  const plan = planRelease(input({
    codes: codes([['1', procedure('99213', { modifiers: ['25', '95'], units: 2 })], ['2', procedure('71046', { modifiers: ['26'] })], ['3', procedure('36415')]], [dx('R07.9', 1)]),
  }));
  assert.deepEqual(plan.lines.map((l) => [l.lineId, l.unitFee, l.amount]), [['L1', 12500, 25000], ['L2', 9000, 9000], ['L3', undefined, undefined]]);
});

test('planRelease renumbers the active diagnoses 1..n in coder sequence and resolves each line by value in pointer order', () => {
  const plan = planRelease(input({
    codes: codes([['1', procedure('99213', { diagnosisCodes: ['I10', 'R07.9', 'X99.9'] })]], [dx('R07.9', 2, 'Chest pain'), dx('I10', 5)]),
  }));
  assert.deepEqual(plan.diagnoses, [{ sequence: 1, code: 'R07.9', codingSystem: 'ICD10', description: 'Chest pain' }, { sequence: 2, code: 'I10', codingSystem: 'ICD10' }]);
  const [line] = plan.lines;
  assert.deepEqual(line!.diagnoses.map((d) => [d.sequence, d.code]), [[2, 'I10'], [1, 'R07.9']], 'pointer order is the line\'s, sequences are the set\'s');
  assert.deepEqual(line!.unresolvedDiagnoses, ['X99.9']);
});

test('planRelease takes the line\'s rendering provider, else the default, else none', () => {
  const plan = planRelease(input({ codes: codes([['1', procedure('99213', { renderingProvider: JONES })], ['2', procedure('99213')]], [dx('R07.9', 1)]) }));
  assert.deepEqual(plan.lines.map((l) => l.renderingProvider?.npi), [JONES.npi, SMITH.npi]);
  assert.equal(planRelease(input({ defaultRendering: undefined })).lines[0]!.renderingProvider, undefined);
});

test('chargesToCreate materializes the unkept lines with the release number in the external id, and refuses an unpriced line', () => {
  const plan = planRelease(input());
  const [charge] = chargesToCreate(plan, E1, 2, nextId);
  assert.deepEqual(charge, {
    id: charge!.id, encounterId: E1, source: 'coder', codeAssignmentId: 'A1', externalId: 'A1#2', transactionType: 'CG', serviceDate: '2026-10-02', codeSystem: 'CPT', code: '99213',
    modifiers: [], units: 1, amount: 12500, diagnoses: [{ sequence: 1, code: 'R07.9', codingSystem: 'ICD10', description: 'Chest pain' }], performingProvider: SMITH,
  });
  assert.throws(() => chargesToCreate(planRelease(input({ schedule: [] })), E1, 1, nextId), /no fee/);
});

test('the keep/void diff: identical facts keep the live charge, any changed fact or a removed line voids it', () => {
  const first = planRelease(input());
  const [existing] = chargesToCreate(first, E1, 1, nextId);
  const same = planRelease(input({ live: [live(existing!)] }));
  assert.deepEqual([same.lines[0]!.keep, same.void], [existing!.id, []], 'unchanged line is kept');
  assert.deepEqual(chargesToCreate(same, E1, 2, nextId), [], 'a kept line creates nothing');

  const repriced = planRelease(input({ live: [live(existing!)], schedule: [{ ...SCHEDULE[0]!, amount: cents(13000) }] }));
  assert.deepEqual([repriced.lines[0]!.keep, repriced.void.map((v) => v.charge.id)], [undefined, [existing!.id]], 'a new amount voids and recreates');
  assert.equal(chargesToCreate(repriced, E1, 2, nextId)[0]!.externalId, 'A1#2');

  const removed = planRelease(input({ live: [live(existing!)], codes: codes([], [dx('R07.9', 1)]) }));
  assert.deepEqual([removed.lines, removed.void.map((v) => v.charge.id)], [[], [existing!.id]], 'a removed line voids its charge');

  const superseded = planRelease(input({ live: [live(existing!)], codes: codes([['9', procedure('99213')]], [dx('R07.9', 1, 'Chest pain')]) }));
  assert.deepEqual([superseded.lines[0]!.keep, superseded.void.map((v) => v.charge.id)], [undefined, [existing!.id]], 'a changed line is a new assignment row, so the old charge goes');

  const resequenced = planRelease(input({ live: [live(existing!)], codes: codes([['1', procedure('99213')]], [dx('I10', 1), dx('R07.9', 2, 'Chest pain')]) }));
  assert.deepEqual([resequenced.lines[0]!.keep, resequenced.void.map((v) => v.charge.id)], [undefined, [existing!.id]], 're-sequenced diagnoses re-bill the line');

  const relabelled = planRelease(input({ live: [live(existing!)], codes: codes([['1', procedure('99213')]], [dx('R07.9', 1, 'Chest pain, unspecified')]) }));
  assert.equal(relabelled.lines[0]!.keep, existing!.id, 'a diagnosis description is not a billed fact');

  const provider = planRelease(input({ live: [live(existing!)], defaultRendering: JONES }));
  assert.equal(provider.lines[0]!.keep, undefined, 'a different performing NPI re-bills');
});
