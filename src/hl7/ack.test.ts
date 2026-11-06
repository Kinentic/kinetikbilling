import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAck, comp, firstSegment, parseHl7 } from './index.ts';

const original = parseHl7('MSH|^~\\&|CERNER|HOSP|BILLING|KINETIK|20261105143000-0800||ADT^A04^ADT_A01|HOSP00000001|T|2.5.1\rPID|1\r');

test('ACK swaps endpoints, echoes the control id and parses back', () => {
  const ack = parseHl7(buildAck(original, 'AA'));
  assert.deepEqual(
    [ack.header.sendingApplication, ack.header.sendingFacility, ack.header.receivingApplication, ack.header.receivingFacility],
    ['BILLING', 'KINETIK', 'CERNER', 'HOSP'],
  );
  assert.equal(ack.header.messageType, 'ACK');
  assert.equal(ack.header.triggerEvent, 'A04');
  assert.equal(ack.header.processingId, 'T');
  assert.equal(ack.header.version, '2.5.1');
  assert.match(ack.header.timestamp, /^\d{14}[+-]\d{4}$/);
  const msa = firstSegment(ack, 'MSA')!;
  assert.equal(comp(msa, 1), 'AA');
  assert.equal(comp(msa, 2), 'HOSP00000001');
  assert.deepEqual(ack.segments.map((s) => s.name), ['MSH', 'MSA']);
});

test('ACK control ids are unique, compact, and differ from the original', () => {
  const ids = new Set(Array.from({ length: 500 }, () => parseHl7(buildAck(original, 'AA')).header.controlId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.ok(id.length > 0 && id.length <= 20, id);
});

test('ACK text with delimiters survives a round trip', () => {
  const text = 'bad | field ^ with ~ all & delims \\ and\nnewline';
  const ack = buildAck(original, 'AE', text);
  assert.ok(!ack.slice(0, -1).includes('\n'));
  assert.equal(comp(firstSegment(parseHl7(ack), 'MSA')!, 3), text);
});

test('ACK defaults processing id to P and ends segments with \\r', () => {
  const noProc = parseHl7('MSH|^~\\&|A|B|C|D|20261105143000||ORU^R01|X1||2.5.1\r');
  const raw = buildAck(noProc, 'AR', 'nope');
  assert.equal(parseHl7(raw).header.processingId, 'P');
  assert.ok(raw.endsWith('\r') && !raw.includes('\n'));
});

test('ACK uses the message own encoding characters', () => {
  const custom = parseHl7('MSH#*+!%#CERNER#HOSP#B#K#20261105143000##ORU*R01#C2#P#2.5.1\r');
  const raw = buildAck(custom, 'AA');
  assert.ok(raw.startsWith('MSH#*+!%'));
  assert.equal(parseHl7(raw).header.triggerEvent, 'R01');
});
