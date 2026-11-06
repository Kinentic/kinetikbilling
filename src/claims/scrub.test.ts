import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, type ChargeState, type ClaimDiagnosis, type IsoDate, type ScrubSeverity } from '../domain/types.ts';
import { buildClaim } from './build.ts';
import type { BillingProviderConfig } from './config.ts';
import { loadClaimContext, type ClaimContext } from './context.ts';
import { RULES, isValidNpi, scrubClaim } from './scrub.ts';
import { addCharge, cfg, seed } from './testkit.ts';

const base = (): ClaimContext => {
  const s = seed();
  addCharge(s);
  return loadClaimContext(s.store, buildClaim(s.store, cfg, s.encounterId).id);
};

const withCharge = (ctx: ClaimContext, patch: Partial<ChargeState>): ClaimContext => ({ ...ctx, charges: [{ ...ctx.charges[0]!, ...patch } as ChargeState] });
const dx = (n: number, code = 'E11.9'): { sequence: number; code: string; codingSystem: 'ICD10' } => ({ sequence: n, code, codingSystem: 'ICD10' });
const manyDiagnoses = (n: number): ClaimDiagnosis[] => Array.from({ length: n }, (_, i) => ({ position: i + 1, code: `E11.${i}`, codingSystem: 'ICD10' }));

test('NPI check digit follows the 80840-prefixed Luhn algorithm', () => {
  assert.equal(isValidNpi('1234567893'), true);
  assert.equal(isValidNpi('1234567890'), false);
  assert.equal(isValidNpi('123456789'), false);
});

test('a clean claim has no violations', () => {
  assert.deepEqual(scrubClaim(base(), cfg), []);
});

const FIXTURES: { rule: string; severity: ScrubSeverity; ctx: (c: ClaimContext) => ClaimContext; cfg?: Partial<BillingProviderConfig> }[] = [
  { rule: 'charges-present', severity: 'error', ctx: (c) => ({ ...c, charges: [] }) },
  { rule: 'total-positive', severity: 'error', ctx: (c) => ({ ...c, claim: { ...c.claim, totalCharge: cents(0) } }) },
  { rule: 'coverage-present', severity: 'error', ctx: ({ coverage: _, ...c }) => c },
  { rule: 'coverage-ids', severity: 'error', ctx: (c) => ({ ...c, coverage: { ...c.coverage!, memberId: '' } }) },
  { rule: 'coverage-ids', severity: 'error', ctx: (c) => ({ ...c, coverage: { ...c.coverage!, payerId: ' ' } }) },
  { rule: 'diagnoses-present', severity: 'error', ctx: (c) => ({ ...c, diagnoses: [] }) },
  { rule: 'diagnosis-icd10-shape', severity: 'error', ctx: (c) => ({ ...c, diagnoses: [{ ...c.diagnoses[0]!, code: '250.00' }, ...c.diagnoses.slice(1)] }) },
  { rule: 'diagnosis-icd10-shape', severity: 'error', ctx: (c) => ({ ...c, diagnoses: [{ ...c.diagnoses[0]!, code: '7X.99' }, ...c.diagnoses.slice(1)] }) },
  { rule: 'patient-demographics', severity: 'warning', ctx: ({ patient: { dob: _, ...p }, ...c }) => ({ ...c, patient: p }) },
  { rule: 'patient-demographics', severity: 'warning', ctx: (c) => ({ ...c, patient: { ...c.patient, sex: 'U' } }) },
  { rule: 'patient-address', severity: 'error', ctx: ({ patient: { address: _, ...p }, ...c }) => ({ ...c, patient: p }) },
  { rule: 'charge-service-date', severity: 'error', ctx: (c) => withCharge(c, { serviceDate: '' as IsoDate }) },
  { rule: 'charge-service-date', severity: 'error', ctx: (c) => withCharge(c, { serviceDate: '2026-10-04' as IsoDate }) },
  { rule: 'charge-service-date', severity: 'error', ctx: (c) => withCharge(c, { serviceDate: '2026-09-30' as IsoDate }) },
  { rule: 'claim-dx-count', severity: 'error', ctx: (c) => ({ ...c, diagnoses: manyDiagnoses(13) }) },
  { rule: 'charge-dx-count', severity: 'error', ctx: (c) => withCharge(c, { diagnoses: [dx(1), dx(2, 'I10'), dx(3, 'J45.909'), dx(4, 'K21.9'), dx(5, 'M54.5')] }) },
  { rule: 'charge-dx-empty', severity: 'warning', ctx: (c) => withCharge(c, { diagnoses: [] }) },
  { rule: 'charge-performing-provider-missing', severity: 'warning', ctx: (c) => withCharge(c, { performingProvider: undefined }) },
  { rule: 'charge-performing-provider-npi', severity: 'error', ctx: (c) => withCharge(c, { performingProvider: { lastName: 'X', firstName: 'Y', npi: '1234567890' } }) },
  { rule: 'charge-modifiers', severity: 'error', ctx: (c) => withCharge(c, { modifiers: ['25', '59', 'XU', 'LT', 'RT'] }) },
  { rule: 'billing-provider-npi', severity: 'error', ctx: (c) => c, cfg: { npi: '1234567890' } },
  { rule: 'duplicate-charge-lines', severity: 'warning', ctx: (c) => ({ ...c, charges: [c.charges[0]!, { ...c.charges[0]!, externalId: 'DUP' }] }) },
];

for (const f of FIXTURES) {
  test(`${f.rule} flags its failing fixture as ${f.severity}`, () => {
    const found = scrubClaim(f.ctx(base()), { ...cfg, ...f.cfg }).filter((v) => v.rule === f.rule);
    assert.ok(found.length > 0, `expected ${f.rule}`);
    assert.ok(found.every((v) => v.severity === f.severity));
  });
}

test('every rule has a failing fixture', () => {
  assert.deepEqual(new Set(RULES.map((r) => r.id)), new Set(FIXTURES.map((f) => f.rule)));
});

test('service dates are not range-checked when the encounter has no discharge', () => {
  const c = base();
  const { dischargeAt: _, ...encounter } = c.encounter;
  assert.deepEqual(scrubClaim(withCharge({ ...c, encounter }, { serviceDate: '2026-12-01' as IsoDate }), cfg), []);
});

test('a credit that reverses a charge is not a duplicate line', () => {
  const c = base();
  const [line] = c.charges;
  const credit = { ...line!, externalId: 'CR1', transactionType: 'CD' as const, amount: cents(-line!.amount) };
  assert.deepEqual(scrubClaim({ ...c, charges: [line!, credit] }, cfg).filter((v) => v.rule === 'duplicate-charge-lines'), []);
});

test('per-charge violations name the charge', () => {
  const c = withCharge(base(), { modifiers: ['1', '2', '3', '4', '5'] });
  assert.equal(scrubClaim(c, cfg).find((v) => v.rule === 'charge-modifiers')!.chargeId, c.charges[0]!.id);
});
