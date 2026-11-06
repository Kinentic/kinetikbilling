import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, type ChargeDiagnosis, type ChargeId, type ChargeState, type EncounterId, type IsoDate } from '../domain/types.ts';
import { claimDiagnoses, pointersFor } from './context.ts';

const dx = (sequence: number, code: string, description?: string): ChargeDiagnosis => ({ sequence, code, codingSystem: 'ICD10', ...(description ? { description } : {}) });
const charge = (...diagnoses: ChargeDiagnosis[]): ChargeState => ({
  id: 'C' as ChargeId, encounterId: 'E' as EncounterId, source: 'cerner_dft', externalId: 'T1', transactionType: 'CG', serviceDate: '2026-10-02' as IsoDate,
  codeSystem: 'CPT', code: '99213', modifiers: [], units: 1, amount: cents(100), diagnoses, status: 'unbilled', claimIds: [],
});

test('claimDiagnoses orders distinct codes by their lowest sequence, then first appearance, and numbers them 1..n', () => {
  const a = charge(dx(3, 'I10'), dx(1, 'E11.9', 'Type 2 diabetes'));
  const b = charge(dx(2, 'J45.909'), dx(2, 'I10'), dx(2, 'K21.9'));
  assert.deepEqual(claimDiagnoses([a, b]), [
    { position: 1, code: 'E11.9', codingSystem: 'ICD10', description: 'Type 2 diabetes' },
    { position: 2, code: 'I10', codingSystem: 'ICD10' },
    { position: 3, code: 'J45.909', codingSystem: 'ICD10' },
    { position: 4, code: 'K21.9', codingSystem: 'ICD10' },
  ]);
  assert.deepEqual(claimDiagnoses([]), []);
  assert.deepEqual(claimDiagnoses([charge()]), []);
});

test('pointersFor gives a charge the positions of its own codes in its own order, at most four', () => {
  const list = claimDiagnoses([charge(dx(1, 'A00.0'), dx(2, 'B00.0'), dx(3, 'C00.0'), dx(4, 'D00.0'), dx(5, 'E00.0'))]);
  assert.deepEqual(pointersFor(charge(dx(2, 'B00.0'), dx(1, 'A00.0')), list), [2, 1]);
  assert.deepEqual(pointersFor(charge(dx(5, 'E00.0'), dx(4, 'D00.0'), dx(3, 'C00.0'), dx(2, 'B00.0'), dx(1, 'A00.0')), list), [5, 4, 3, 2]);
  assert.deepEqual(pointersFor(charge(), list), []);
  assert.deepEqual(pointersFor(charge(dx(1, 'Z99.9')), list), [], 'a code outside the list has no position');
});
