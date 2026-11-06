import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hl7ParseError, comp, field, firstSegment, parseHl7, repComp, reps, segments } from './index.ts';

const msg = (...lines: string[]): string => lines.join('\r') + '\r';
const MSH = 'MSH|^~\\&|CERNER|HOSP|BILLING|KINETIK|20261105143000-0800||ADT^A04^ADT_A01|C1|P|2.5.1';

test('MSH field numbering: 1 is the separator, 2 the encoding chars, 9 the message type', () => {
  const m = parseHl7(msg(MSH));
  const msh = firstSegment(m, 'MSH')!;
  assert.equal(comp(msh, 1), '|');
  assert.equal(comp(msh, 2), '^~\\&');
  assert.equal(comp(msh, 3), 'CERNER');
  assert.equal(comp(msh, 9, 1), 'ADT');
  assert.equal(comp(msh, 9, 2), 'A04');
  assert.equal(comp(msh, 12), '2.5.1');
  assert.deepEqual(m.header, {
    sendingApplication: 'CERNER', sendingFacility: 'HOSP', receivingApplication: 'BILLING', receivingFacility: 'KINETIK',
    timestamp: '20261105143000-0800', messageType: 'ADT', triggerEvent: 'A04', controlId: 'C1', processingId: 'P', version: '2.5.1',
  });
});

test('non-MSH segments number fields from the first field after the name', () => {
  const pid = firstSegment(parseHl7(msg(MSH, 'PID|1||1000001^^^HOSP^MR||DOE^JANE')), 'PID')!;
  assert.equal(comp(pid, 1), '1');
  assert.equal(comp(pid, 5, 1), 'DOE');
  assert.equal(comp(pid, 5, 2), 'JANE');
});

test('trigger event derives from MSH-9.3 when MSH-9.2 is empty', () => {
  const m = parseHl7(msg(MSH.replace('ADT^A04^ADT_A01', 'ADT^^ADT_A08')));
  assert.equal(m.header.triggerEvent, 'A08');
});

test('repeating PID-3 is reachable through reps', () => {
  const pid = firstSegment(parseHl7(msg(MSH, 'PID|1||1000001^^^HOSP^MR~900123456^^^USSSA^SS')), 'PID')!;
  const ids = reps(pid, 3);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids.map((r) => [repComp(r, 1), repComp(r, 5)]), [['1000001', 'MR'], ['900123456', 'SS']]);
});

test('every escape sequence round-trips to its literal', () => {
  const m = parseHl7(msg(MSH, 'NTE|1||a\\F\\b\\S\\c\\T\\d\\R\\e\\E\\f\\.br\\g\\X41\\\\X0D0A\\\\Z99\\'));
  const text = comp(firstSegment(m, 'NTE')!, 3);
  assert.equal(text, 'a|b^c&d~e\\f\ng' + 'A' + '\r\n' + '\\Z99\\');
});

test('escaped delimiters do not split fields', () => {
  const nte = firstSegment(parseHl7(msg(MSH, 'NTE|1||x\\F\\y\\S\\z')), 'NTE')!;
  assert.equal(field(nte, 3).length, 1);
  assert.equal(comp(nte, 3, 1), 'x|y^z');
  assert.equal(comp(nte, 3, 2), '');
});

test('a message with custom encoding characters parses with them', () => {
  const m = parseHl7('MSH#*+!%#CERNER#HOSP#B#K#20261105143000##ORU*R01#C2#P#2.5.1\rOBX#1#ST#a*b%c');
  assert.equal(m.encoding.field, '#');
  assert.equal(m.encoding.component, '*');
  assert.equal(comp(m.segments[0]!, 2), '*+!%');
  assert.equal(comp(m.segments[1]!, 3, 2, 2), 'c');
});

test('absent fields default so callers never null-check', () => {
  const pid = firstSegment(parseHl7(msg(MSH, 'PID|1')), 'PID')!;
  assert.deepEqual(field(pid, 40), [[['']]]);
  assert.deepEqual(reps(pid, 40), []);
  assert.deepEqual(reps(pid, 3), []);
  assert.equal(comp(pid, 40, 3, 2), '');
  assert.equal(repComp([], 2), '');
});

test('segments returns every match in order and firstSegment undefined when absent', () => {
  const m = parseHl7(msg(MSH, 'IN1|1', 'GT1|1', 'IN1|2'));
  assert.deepEqual(segments(m, 'IN1').map((s) => comp(s, 1)), ['1', '2']);
  assert.equal(firstSegment(m, 'FT1'), undefined);
});

test('accepts \\r, \\n and \\r\\n separators and ignores trailing blanks', () => {
  for (const sep of ['\r', '\n', '\r\n']) {
    const m = parseHl7([MSH, 'PID|1', 'PV1|1'].join(sep) + sep + sep);
    assert.deepEqual(m.segments.map((s) => s.name), ['MSH', 'PID', 'PV1']);
  }
});

test('parse errors name what is wrong', () => {
  assert.throws(() => parseHl7(''), Hl7ParseError);
  assert.throws(() => parseHl7('PID|1|2'), /first segment must be MSH/);
  assert.throws(() => parseHl7('MSH|^~\\&|A|B'), /at least 12 fields/);
  assert.throws(() => parseHl7('MSH'), Hl7ParseError);
  assert.throws(() => parseHl7(msg(MSH, 'garbage line')), /invalid segment/);
});
