import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMoney } from './money.ts';

test('parseMoney converts decimal text to exact cents', () => {
  const cases: [string, number | undefined][] = [
    ['125.00', 12500], ['-17.5', -1750], ['17', 1700], ['0.07', 7], ['.5', 50], [' 3.10 ', 310], ['+2.00', 200],
    ['0.1', 10], ['19.999', 2000], ['-0.00', 0], ['', undefined], ['abc', undefined], ['1.2.3', undefined], ['.', undefined], ['1e3', undefined],
  ];
  for (const [text, want] of cases) assert.equal(parseMoney(text), want, JSON.stringify(text));
});
