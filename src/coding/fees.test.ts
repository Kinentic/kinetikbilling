import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../db/store.ts';
import { cents, type Cents, type FeeScheduleLine, type IsoDate } from '../domain/types.ts';
import { FeeScheduleError, replaceFeeSchedule, unitFee } from './fees.ts';

const d = (s: string): IsoDate => s as IsoDate;
const line = (code: string, modifiers: string[], amount: number, effectiveFrom: string, effectiveTo?: string): FeeScheduleLine =>
  ({ code, modifiers, amount: cents(amount), effectiveFrom: d(effectiveFrom), ...(effectiveTo ? { effectiveTo: d(effectiveTo) } : {}) });

const SCHEDULE: FeeScheduleLine[] = [
  line('99213', [], 12500, '2026-01-01', '2027-01-01'),
  line('99213', [], 13000, '2027-01-01'),
  line('99213', ['26'], 9000, '2026-01-01'),
  line('71046', ['TC'], 4000, '2026-01-01'),
];

test('unitFee matches the exact modifier set first, then the base line, within [effectiveFrom, effectiveTo)', () => {
  assert.equal(unitFee(SCHEDULE, '99213', [], d('2026-06-01')), 12500);
  assert.equal(unitFee(SCHEDULE, '99213', ['26'], d('2026-06-01')), 9000, 'a pricing modifier carries its own price');
  assert.equal(unitFee(SCHEDULE, '99213', ['25', '95'], d('2026-06-01')), 12500, 'informational modifiers fall through to the base');
  assert.equal(unitFee(SCHEDULE, '99213', ['95', '26'], d('2026-06-01')), 12500, 'only the exact set matches; a superset of a priced set takes the base');
  assert.equal(unitFee(SCHEDULE, '99213', [], d('2026-12-31')), 12500);
  assert.equal(unitFee(SCHEDULE, '99213', [], d('2027-01-01')), 13000, 'effectiveTo is exclusive');
  assert.equal(unitFee(SCHEDULE, '99213', [], d('2025-12-31')), undefined, 'before the first effective date');
  assert.equal(unitFee(SCHEDULE, '71046', [], d('2026-06-01')), undefined, 'a modifier-only line is not a base price');
  assert.equal(unitFee(SCHEDULE, '71046', ['TC'], d('2026-06-01')), 4000);
  assert.equal(unitFee(SCHEDULE, '99999', [], d('2026-06-01')), undefined);
});

test('replaceFeeSchedule stores the whole set normalized and reads it back', () => {
  const store = new Store(':memory:');
  const saved = replaceFeeSchedule(store, [line(' 99213 ', [], 12500, '2026-01-01'), line('g0438', ['tc', '26'].map((m) => m.toUpperCase()), 100, '2026-01-01')]);
  assert.deepEqual(saved, [
    { code: '99213', modifiers: [], amount: 12500, effectiveFrom: '2026-01-01' },
    { code: 'G0438', modifiers: ['26', 'TC'], amount: 100, effectiveFrom: '2026-01-01' },
  ]);
  assert.deepEqual(store.listFeeSchedule(), saved);
  assert.deepEqual(replaceFeeSchedule(store, []), [], 'replacement is whole-set');
});

test('replaceFeeSchedule refuses bad lines before writing anything', () => {
  const store = new Store(':memory:');
  const before = replaceFeeSchedule(store, [line('99213', [], 12500, '2026-01-01')]);
  const refused = (lines: FeeScheduleLine[], why: RegExp): void => {
    assert.throws(() => replaceFeeSchedule(store, lines), (e: unknown) => e instanceof FeeScheduleError && why.test(e.message));
    assert.deepEqual(store.listFeeSchedule(), before, 'a refused replacement leaves the schedule as it was');
  };
  refused([line('99213', [], -1, '2026-01-01')], /non-negative integer/);
  refused([{ ...line('99213', [], 125, '2026-01-01'), amount: 125.5 as Cents }], /non-negative integer/);
  refused([line('  ', [], 100, '2026-01-01')], /code is empty/);
  refused([line('99213', [], 100, '2026-06-01', '2026-06-01')], /not after/);
  refused([line('99213', [], 100, '2026-01-01', '2026-07-01'), line('99213', [], 110, '2026-06-01')], /overlaps/);
  refused([line('99213', [], 100, '2026-01-01'), line('99213', [], 110, '2027-01-01')], /overlaps/);
  assert.equal(replaceFeeSchedule(store, [line('99213', [], 100, '2026-01-01', '2027-01-01'), line('99213', [], 110, '2027-01-01'), line('99213', ['26'], 90, '2026-01-01')]).length, 3,
    'adjacent ranges and different modifier sets do not overlap');
});
