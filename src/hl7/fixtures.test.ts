import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildAck, comp, firstSegment, parseHl7, reps, repComp, segments, startMllpServer } from './index.ts';

const dir = new URL('../../fixtures/hl7/', import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), 'utf8');
const expected: Record<string, string> = {
  'adt-a04-register.hl7': 'ADT^A04', 'adt-a08-update.hl7': 'ADT^A08', 'adt-a03-discharge.hl7': 'ADT^A03',
  'adt-a40-merge.hl7': 'ADT^A40', 'dft-p03-charges.hl7': 'DFT^P03', 'bar-p01-account.hl7': 'BAR^P01',
  'mdm-t02-progress-note.hl7': 'MDM^T02', 'mdm-t08-corrected-note.hl7': 'MDM^T08',
  'oru-r01-radiology-preliminary.hl7': 'ORU^R01', 'oru-r01-radiology-final.hl7': 'ORU^R01',
};

test('each fixture parses with the expected type and trigger, \\r terminators and unique control ids', () => {
  const ids = new Set<string>();
  for (const [file, type] of Object.entries(expected)) {
    const raw = load(file);
    assert.ok(!raw.includes('\n'), file);
    const m = parseHl7(raw);
    assert.equal(`${m.header.messageType}^${m.header.triggerEvent}`, type, file);
    assert.equal(m.header.sendingApplication, 'CERNER');
    assert.equal(m.header.sendingFacility, 'HOSP');
    assert.equal(m.header.version, '2.5.1');
    assert.match(m.header.timestamp, /-0800$/);
    ids.add(m.header.controlId);
    const pid = firstSegment(m, 'PID')!;
    assert.equal(repComp(reps(pid, 3)[0]!, 1), '1000001');
    assert.equal(comp(pid, 18), 'FIN000123');
  }
  assert.equal(ids.size, Object.keys(expected).length);
});

test('A04 carries two identifiers, two insurances with priorities and two I10 diagnoses', () => {
  const m = parseHl7(load('adt-a04-register.hl7'));
  assert.equal(reps(firstSegment(m, 'PID')!, 3).length, 2);
  assert.equal(comp(firstSegment(m, 'PV1')!, 7, 1), '1234567893');
  assert.equal(comp(firstSegment(m, 'PV1')!, 7, 13), 'NPI');
  assert.deepEqual(segments(m, 'IN1').map((s) => [comp(s, 22), comp(s, 36)]), [['1', 'XYZ123456789'], ['2', 'AET998877']]);
  assert.deepEqual(segments(m, 'DG1').map((s) => [comp(s, 3, 1), comp(s, 3, 3)]), [['R07.9', 'I10'], ['I10', 'I10']]);
});

test('A03 sets PV1-45, A40 carries the prior MRN, DFT has two charges and a credit', () => {
  assert.equal(comp(firstSegment(parseHl7(load('adt-a03-discharge.hl7')), 'PV1')!, 45), '20261108101500-0800');
  assert.equal(comp(firstSegment(parseHl7(load('adt-a40-merge.hl7')), 'MRG')!, 1, 1), '1000099');
  const ft1 = segments(parseHl7(load('dft-p03-charges.hl7')), 'FT1');
  assert.deepEqual(ft1.map((s) => [comp(s, 6), comp(s, 25, 1), comp(s, 10), comp(s, 11)]),
    [['CG', '99213', '1', '125.00'], ['CG', '36415', '1', '17.00'], ['CD', '36415', '1', '17.00']]);
  assert.equal(reps(ft1[0]!, 26).length, 2);
  assert.equal(comp(ft1[0]!, 19, 1), 'R07.9');
  assert.equal(comp(ft1[0]!, 20, 13), 'NPI');
});

test('the MDM pair shares TXA-12 with AU then LA status; the ORU pair shares OBR-3 with P then F', () => {
  const [t02, t08] = ['mdm-t02-progress-note.hl7', 'mdm-t08-corrected-note.hl7'].map((f) => firstSegment(parseHl7(load(f)), 'TXA')!);
  assert.deepEqual([comp(t02!, 12, 1), comp(t08!, 12, 1)], ['DOC0001', 'DOC0001']);
  assert.deepEqual([comp(t02!, 17), comp(t08!, 17)], ['AU', 'LA']);
  assert.equal(comp(t02!, 5, 13), 'NPI');
  assert.equal(segments(parseHl7(load('mdm-t02-progress-note.hl7')), 'OBX').length, 3);
  const [prelim, final] = ['oru-r01-radiology-preliminary.hl7', 'oru-r01-radiology-final.hl7'].map((f) => firstSegment(parseHl7(load(f)), 'OBR')!);
  assert.deepEqual([comp(prelim!, 3, 1), comp(final!, 3, 1)], ['RAD5501', 'RAD5501']);
  assert.deepEqual([comp(prelim!, 25), comp(final!, 25)], ['P', 'F']);
  assert.equal(comp(final!, 32, 1, 1), '2222222226');
});

test('scripts/send-hl7.ts sends fixtures over MLLP and reports AA, exiting 0', async () => {
  const server = await startMllpServer({ port: 0, host: '127.0.0.1', onMessage: async (raw) => buildAck(parseHl7(raw), 'AA', 'stored') });
  const script = new URL('../../scripts/send-hl7.ts', import.meta.url).pathname;
  const files = ['adt-a04-register.hl7', 'dft-p03-charges.hl7'].map((f) => new URL(f, dir).pathname);
  const { stdout } = await promisify(execFile)('node', [script, `127.0.0.1:${server.port}`, ...files]);
  await server.close();
  const lines = stdout.trim().split('\n');
  assert.deepEqual(lines.map((l) => l.split(': ')[1]), ['AA stored', 'AA stored']);
});

test('scripts/send-hl7.ts exits non-zero when the receiver rejects', async () => {
  const server = await startMllpServer({ port: 0, host: '127.0.0.1', onMessage: async (raw) => buildAck(parseHl7(raw), 'AE', 'rejected') });
  const script = new URL('../../scripts/send-hl7.ts', import.meta.url).pathname;
  const file = new URL('adt-a04-register.hl7', dir).pathname;
  await assert.rejects(promisify(execFile)('node', [script, `127.0.0.1:${server.port}`, file]), (e: { code?: number; stdout?: string }) => e.code === 1 && /AE rejected/.test(e.stdout ?? ''));
  await server.close();
});
