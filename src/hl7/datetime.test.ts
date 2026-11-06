import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHl7DateTime, parseHl7Date, parseHl7DateTime } from './index.ts';

test('parseHl7DateTime keeps an explicit offset', () => {
  assert.equal(parseHl7DateTime('20261105143000-0800'), '2026-11-05T14:30:00-08:00');
  assert.equal(parseHl7DateTime('20261105143000+0530'), '2026-11-05T14:30:00+05:30');
});

test('parseHl7DateTime pads missing components and defaults the offset without converting', () => {
  assert.equal(parseHl7DateTime('2026'), '2026-01-01T00:00:00+00:00');
  assert.equal(parseHl7DateTime('202611'), '2026-11-01T00:00:00+00:00');
  assert.equal(parseHl7DateTime('202611051430'), '2026-11-05T14:30:00+00:00');
});

test('parseHl7DateTime keeps fractional seconds up to 3 digits', () => {
  assert.equal(parseHl7DateTime('20261105143000.5'), '2026-11-05T14:30:00.500+00:00');
  assert.equal(parseHl7DateTime('20261105143000.1234-0800'), '2026-11-05T14:30:00.123-08:00');
});

test('parseHl7DateTime rejects anything outside the DTM grammar', () => {
  for (const bad of ['', 'abc', '2026110', '20261305', '20261100', '20261105250000', '20261105146000', '20261105143000-08', '2026-11-05', '20261105.5']) {
    assert.equal(parseHl7DateTime(bad), undefined, bad);
  }
});

test('parseHl7Date takes the first 8 digits', () => {
  assert.equal(parseHl7Date('19850214'), '1985-02-14');
  assert.equal(parseHl7Date('20261105143000-0800'), '2026-11-05');
});

test('parseHl7Date rejects short, non-numeric and out-of-range values', () => {
  for (const bad of ['', '1985', '198502', 'abcdefgh', '19851301', '19850200', '19850232']) {
    assert.equal(parseHl7Date(bad), undefined, bad);
  }
});

test('formatHl7DateTime emits local wall time with the local offset and parses back to the same instant', () => {
  const d = new Date(2026, 10, 5, 14, 30, 0);
  const s = formatHl7DateTime(d);
  assert.match(s, /^20261105143000[+-]\d{4}$/);
  const iso = parseHl7DateTime(s)!;
  assert.equal(new Date(iso).getTime(), d.getTime());
});
