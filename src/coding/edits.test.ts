import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cfg } from '../claims/testkit.ts';
import {
  cents, type ChargeId, type ClaimStatus, type CodeAssignment, type CodeAssignmentId, type CodeContent, type CodeLineId, type CodingTask, type CodingTaskId, type Coverage, type CoverageId,
  type DiagnosisCode, type Encounter, type EncounterId, type FeeScheduleLine, type IsoDate, type IsoDateTime, type MessageId, type PatientId, type ProcedureCode, type Provider,
} from '../domain/types.ts';
import { activeCodes, deriveCodeSet } from './codes.ts';
import { CODING_RULES, runCodingEdits } from './edits.ts';
import { chargesToCreate, planRelease, type LiveCharge } from './plan.ts';
import type { CodingContext } from './workbench.ts';

const AT = '2026-11-08T18:00:00.000Z' as IsoDateTime;
const E1 = 'E1' as EncounterId;
const SMITH: Provider = { npi: '1234567893', lastName: 'Smith', firstName: 'Robert' };
const task: CodingTask = { id: 'T1' as CodingTaskId, encounterId: E1, status: 'in_progress', origin: { kind: 'discharge', messageId: 'M1' as MessageId }, createdAt: AT, updatedAt: AT };
const encounter: Encounter = { id: E1, patientId: 'P1' as PatientId, accountNumber: 'FIN1', facility: 'HOSP', patientClass: 'O', updatedAt: AT };
const coverage: Coverage = { id: 'V1' as CoverageId, encounterId: E1, priority: 1, payerId: '60054', payerName: 'Aetna', memberId: 'W1', relationship: 'self', subscriber: { lastName: 'Doe', firstName: 'Jane' } };
const SCHEDULE: FeeScheduleLine[] = [{ code: '99213', modifiers: [], amount: cents(12500), effectiveFrom: '2026-01-01' as IsoDate }];

let n = 0;
const row = (content: CodeContent, extra: Partial<CodeAssignment> = {}): CodeAssignment => ({
  id: `A${++n}` as CodeAssignmentId, encounterId: E1, lineId: `L${n}` as CodeLineId, content, removed: false, provenance: 'coder', decision: { by: 'coder-1', at: AT }, recordedAt: AT, ...extra,
});
const procedure = (extra: Partial<ProcedureCode> = {}): ProcedureCode => ({ kind: 'procedure', codeSystem: 'CPT', code: '99213', modifiers: [], units: 1, serviceDate: '2026-10-02' as IsoDate, diagnosisCodes: ['R07.9'], ...extra });
const dx = (code: string, sequence: number): DiagnosisCode => ({ kind: 'diagnosis', code, sequence });

interface Shape { rows?: CodeAssignment[]; schedule?: FeeScheduleLine[]; live?: LiveCharge[]; defaultRendering?: Provider; coverage?: Coverage }
const context = (over: Shape = {}): CodingContext => {
  const codes = deriveCodeSet(over.rows ?? [row(procedure()), row(dx('R07.9', 1))]);
  const rendering = 'defaultRendering' in over ? over.defaultRendering : SMITH;
  const cov = 'coverage' in over ? over.coverage : coverage;
  return {
    task, encounter, ...(cov ? { coverage: cov } : {}), documents: [], codes,
    plan: planRelease({ codes: activeCodes(codes), schedule: over.schedule ?? SCHEDULE, live: over.live ?? [], ...(rendering ? { defaultRendering: rendering } : {}) }),
  };
};
const findings = (ctx: CodingContext): [string, string, string | undefined][] => runCodingEdits(ctx, cfg).map((v) => [v.rule, v.severity, v.lineId ?? v.chargeId]);

test('a decided, priced, resolved set with a rendering provider and coverage passes every rule', () => {
  assert.deepEqual(findings(context()), []);
  assert.deepEqual(CODING_RULES.map((r) => r.id), [
    'proposals-decided', 'procedure-present', 'diagnosis-present', 'diagnosis-icd10-shape', 'line-dx-resolved', 'line-dx-count', 'claim-dx-count', 'fee-on-file',
    'billed-claim-locked', 'rendering-provider', 'coverage-present',
  ]);
});

test('proposals-decided: a current row without a decision is an error on its line', () => {
  const pending = row(procedure({ code: '36415' }), { provenance: 'cerner_dft', sourceRef: 'T2' });
  delete pending.decision;
  assert.deepEqual(findings(context({ rows: [row(procedure()), row(dx('R07.9', 1)), pending] })), [['proposals-decided', 'error', pending.lineId]]);
});

test('procedure-present and diagnosis-present: an empty side of the set is an error', () => {
  assert.deepEqual(findings(context({ rows: [row(dx('R07.9', 1))] })), [['procedure-present', 'error', undefined]]);
  const only = row(procedure());
  assert.deepEqual(findings(context({ rows: [only] })), [['diagnosis-present', 'error', undefined], ['line-dx-resolved', 'error', only.lineId]]);
  const removed = row(dx('R07.9', 1), { removed: true });
  assert.deepEqual(findings(context({ rows: [only, removed] })).map(([rule]) => rule), ['diagnosis-present', 'line-dx-resolved'], 'a removed line is not active');
});

test('diagnosis-icd10-shape: a malformed active diagnosis is an error on its line', () => {
  const bad = row(dx('CHEST PAIN', 1));
  assert.deepEqual(findings(context({ rows: [row(procedure({ diagnosisCodes: ['CHEST PAIN'] })), bad] })), [['diagnosis-icd10-shape', 'error', bad.lineId]]);
});

test('line-dx-resolved: a line naming a diagnosis outside the active set is an error on the line', () => {
  const line = row(procedure({ diagnosisCodes: ['R07.9', 'E11.9'] }));
  assert.deepEqual(findings(context({ rows: [line, row(dx('R07.9', 1))] })), [['line-dx-resolved', 'error', line.lineId]]);
});

test('line-dx-count: more than four diagnosis pointers on a line is an error', () => {
  const codes = ['R07.9', 'I10', 'E11.9', 'J45.909', 'K21.9'];
  const line = row(procedure({ diagnosisCodes: codes }));
  assert.deepEqual(findings(context({ rows: [line, ...codes.map((c, i) => row(dx(c, i + 1)))] })), [['line-dx-count', 'error', line.lineId]]);
});

test('claim-dx-count: more than twelve active diagnoses is an error', () => {
  const codes = Array.from({ length: 13 }, (_, i) => `Z${String(i).padStart(2, '0')}.0`);
  assert.deepEqual(findings(context({ rows: [row(procedure({ diagnosisCodes: [codes[0]!] })), ...codes.map((c, i) => row(dx(c, i + 1)))] })), [['claim-dx-count', 'error', undefined]]);
});

test('fee-on-file: a line with no fee for its code, modifiers and date is an error on the line', () => {
  const line = row(procedure());
  assert.deepEqual(findings(context({ rows: [line, row(dx('R07.9', 1))], schedule: [] })), [['fee-on-file', 'error', line.lineId]]);
  assert.deepEqual(findings(context({ rows: [line, row(dx('R07.9', 1))], schedule: [{ ...SCHEDULE[0]!, effectiveFrom: '2026-11-01' as IsoDate }] })), [['fee-on-file', 'error', line.lineId]], 'the service date decides');
});

test('billed-claim-locked: voiding a charge that sits on a claim past OPEN is an error on the charge; an open claim is not', () => {
  const kept = row(procedure());
  const onClaim = (status: ClaimStatus): LiveCharge => {
    const [charge] = chargesToCreate(planRelease({ codes: activeCodes(deriveCodeSet([kept, row(dx('R07.9', 1))])), schedule: SCHEDULE, live: [], defaultRendering: SMITH }), E1, 1, () => 'C1' as ChargeId);
    return { charge: charge!, claims: [{ id: 'K1' as never, status }] };
  };
  const changed = row(procedure({ code: '99214' }), { lineId: kept.lineId, supersedes: kept.id });
  const voiding = (status: ClaimStatus): Shape => ({ rows: [kept, row(dx('R07.9', 1)), changed], live: [onClaim(status)], schedule: [...SCHEDULE, { ...SCHEDULE[0]!, code: '99214' }] });
  assert.deepEqual(findings(context(voiding('submitted'))), [['billed-claim-locked', 'error', 'C1']]);
  assert.deepEqual(findings(context(voiding('paid'))), [['billed-claim-locked', 'error', 'C1']]);
  assert.deepEqual(findings(context(voiding('ready'))), [], 'a claim still open takes the change');
  assert.deepEqual(findings(context({ rows: [kept, row(dx('R07.9', 1))], live: [onClaim('submitted')] })), [], 'an unchanged line on a submitted claim is kept, not voided');
});

test('rendering-provider: a line with no provider and no default is a warning on the line', () => {
  const line = row(procedure());
  assert.deepEqual(findings(context({ rows: [line, row(dx('R07.9', 1))], defaultRendering: undefined })), [['rendering-provider', 'warning', line.lineId]]);
  assert.deepEqual(findings(context({ rows: [row(procedure({ renderingProvider: SMITH })), row(dx('R07.9', 1))], defaultRendering: undefined })), [], 'the line\'s own provider satisfies it');
});

test('coverage-present: no priority-1 coverage is a warning', () => {
  assert.deepEqual(findings(context({ coverage: undefined })), [['coverage-present', 'warning', undefined]]);
});
