// Fee schedule: lookup is pure; replacement validates then hands the whole set to the Store.

import type { Store } from '../db/store.ts';
import type { Cents, FeeScheduleLine, IsoDate } from '../domain/types.ts';

export class FeeScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeScheduleError';
  }
}

const modifiersKey = (modifiers: readonly string[]): string => [...modifiers].sort().join(':');

const inEffect = (line: FeeScheduleLine, on: IsoDate): boolean => line.effectiveFrom <= on && (line.effectiveTo === undefined || on < line.effectiveTo);

/**
 * Per-unit fee for a code on a date. Exact modifier set first (sorted compare), then the
 * modifier-agnostic base line ([]), so pricing modifiers (26, TC) can carry their own
 * price while informational ones (25, 95) fall through to the base. Effective range is
 * [effectiveFrom, effectiveTo). Undefined means "no fee on file": a coding-edit error.
 */
export function unitFee(schedule: readonly FeeScheduleLine[], code: string, modifiers: readonly string[], on: IsoDate): Cents | undefined {
  const candidates = schedule.filter((l) => l.code === code && inEffect(l, on));
  const key = modifiersKey(modifiers);
  return (candidates.find((l) => modifiersKey(l.modifiers) === key) ?? candidates.find((l) => l.modifiers.length === 0))?.amount;
}

const normalize = (line: FeeScheduleLine, i: number): FeeScheduleLine => {
  const code = line.code.trim().toUpperCase();
  if (code === '') throw new FeeScheduleError(`lines[${i}]: code is empty`);
  if (!Number.isInteger(line.amount) || line.amount < 0) throw new FeeScheduleError(`lines[${i}] ${code}: amount must be a non-negative integer number of cents`);
  if (line.effectiveTo !== undefined && line.effectiveTo <= line.effectiveFrom) throw new FeeScheduleError(`lines[${i}] ${code}: effectiveTo ${line.effectiveTo} is not after effectiveFrom ${line.effectiveFrom}`);
  return { ...line, code, modifiers: [...line.modifiers].sort() };
};

/**
 * Replaces the whole schedule. Refuses (FeeScheduleError) negative or non-integer
 * amounts, empty codes, effectiveTo <= effectiveFrom, and overlapping ranges for the
 * same (code, modifiers). Already-created charges keep their amounts: price is fixed at release.
 */
export function replaceFeeSchedule(store: Store, lines: readonly FeeScheduleLine[]): FeeScheduleLine[] {
  const normalized = lines.map(normalize);
  const byKey = Map.groupBy(normalized, (l) => `${l.code}|${modifiersKey(l.modifiers)}`);
  for (const [key, group] of byKey) {
    group.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1]!;
      if (prev.effectiveTo === undefined || prev.effectiveTo > group[i]!.effectiveFrom) {
        throw new FeeScheduleError(`${key.replace('|', ' ')}: range from ${prev.effectiveFrom} overlaps range from ${group[i]!.effectiveFrom}`);
      }
    }
  }
  store.replaceFeeSchedule(normalized);
  return store.listFeeSchedule();
}
