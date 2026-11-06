import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as claims from '../claims/index.ts';
import * as coding from '../coding/index.ts';
import { STATUS_BY_ERROR_NAME } from './router.ts';

const errorNames = (mod: Record<string, unknown>): string[] => Object.values(mod)
  .filter((v): v is new (...args: never[]) => Error => typeof v === 'function' && v.prototype instanceof Error)
  .map((Cls) => new Cls(...(['a', 'b', 'c'] as never[])).name);

test('every error class exported from claims and coding has a status row, so none becomes a 500', () => {
  const names = [...errorNames(claims), ...errorNames(coding)];
  assert.ok(names.length >= 12, names.join(','));
  assert.deepEqual(names.filter((n) => STATUS_BY_ERROR_NAME[n] === undefined), []);
  assert.equal(new Set(names).size, names.length, 'the router maps by name, so names must be distinct');
});
