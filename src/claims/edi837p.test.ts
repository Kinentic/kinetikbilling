import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, type IsoDate } from '../domain/types.ts';
import { buildClaim } from './build.ts';
import { loadClaimContext } from './context.ts';
import { build837P } from './edi837p.ts';
import { X12Writer } from './x12.ts';
import { BILLING_NPI, addCharge, cfg, seed, type Seeded } from './testkit.ts';

const controls = { interchangeControlNumber: 42, groupControlNumber: 7, transactionSetControlNumber: 1, now: new Date('2026-11-05T14:30:00Z') };

const render = (s: Seeded) => build837P(loadClaimContext(s.store, buildClaim(s.store, cfg, s.encounterId).id), cfg, controls);
const segments = (x12: string) => x12.split('\n').filter((l) => l.length > 0);
const elements = (x12: string, id: string) => segments(x12).filter((l) => l.startsWith(`${id}*`)).map((l) => l.slice(0, -1).split('*'));

test('a self-subscriber claim renders the 005010X222A1 loops in order', () => {
  const s = seed();
  addCharge(s, { externalId: 'FT1-A', code: '99213', modifiers: ['25'], amount: cents(12550), diagnoses: [{ sequence: 2, code: 'I10', codingSystem: 'ICD10' }, { sequence: 1, code: 'E11.9', codingSystem: 'ICD10' }] });
  addCharge(s, { externalId: 'FT1-B', code: '36415', amount: cents(1500), diagnoses: [], performingProvider: { lastName: 'Smith', firstName: 'Ann', npi: BILLING_NPI } });
  assert.deepEqual(segments(render(s)), [
    'ISA*00*          *00*          *ZZ*KINETIK01      *ZZ*CLEARHOUSE     *261105*1430*^*00501*000000042*0*P*:~',
    'GS*HC*KINETIK01*CLEARHOUSE*20261105*1430*7*X*005010X222A1~',
    'ST*837*0001*005010X222A1~',
    'BHT*0019*00*FIN000123-1*20261105*1430*CH~',
    'NM1*41*2*Kinetik Billing*****46*KINETIK01~',
    'PER*IC*Billing Office*TE*8165550100~',
    'NM1*40*2*Clearinghouse*****46*CLEARHOUSE~',
    'HL*1**20*1~',
    'PRV*BI*PXC*207Q00000X~',
    'NM1*85*2*Kinetik Medical Group*****XX*1234567893~',
    'N3*1 Main St~',
    'N4*Kansas City*MO*64105~',
    'REF*EI*123456789~',
    'HL*2*1*22*0~',
    'SBR*P*18*GRP42******CI~',
    'NM1*IL*1*Doe*Jane*Q***MI*W123456789~',
    'N3*9 Elm St~',
    'N4*Lenexa*KS*66215~',
    'DMG*D8*19800203*F~',
    'NM1*PR*2*Aetna*****PI*60054~',
    'CLM*FIN000123-1*140.50***22:B:1*Y*A*Y*Y~',
    'HI*ABK:E119*ABF:I10~',
    'NM1*82*1*Smith*Ann****XX*1987654328~',
    'LX*1~',
    'SV1*HC:99213:25*125.50*UN*1***2:1~',
    'DTP*472*D8*20261002~',
    'REF*6R*FT1-A~',
    'LX*2~',
    'SV1*HC:36415*15.00*UN*1***1~',
    'DTP*472*D8*20261002~',
    'REF*6R*FT1-B~',
    'SE*30*0001~',
    'GE*1*7~',
    'IEA*1*000000042~',
  ]);
});

test('SE01 equals the segments from ST through SE', () => {
  const s = seed();
  for (let i = 0; i < 5; i++) addCharge(s, { code: `9921${i}` });
  const lines = segments(render(s));
  const st = lines.findIndex((l) => l.startsWith('ST*'));
  const se = lines.findIndex((l) => l.startsWith('SE*'));
  assert.equal(Number(lines[se]!.split('*')[1]!.replace('~', '')), se - st + 1);
});

test('CLM02 is the signed total and each charge gets one LX and one SV1, credits negative', () => {
  const s = seed();
  addCharge(s, { externalId: 'A', amount: cents(20000) });
  addCharge(s, { externalId: 'B', code: '36415', amount: cents(123456) });
  addCharge(s, { externalId: 'C', code: '36415', transactionType: 'CD', amount: cents(-5) });
  const x12 = render(s);
  assert.equal(elements(x12, 'CLM')[0]![2], '1434.51');
  assert.equal(elements(x12, 'LX').length, 3);
  assert.deepEqual(elements(x12, 'SV1').map((e) => e[2]), ['200.00', '1234.56', '-0.05']);
});

test('a dependent patient gets the 2000C loop with the subscriber in 2010BA', () => {
  const s = seed({
    coverage: {
      relationship: 'child',
      subscriber: { lastName: 'Doe', firstName: 'John', dob: '1950-05-06' as IsoDate, sex: 'M', address: { line1: '5 Oak', city: 'Olathe', state: 'KS', zip: '66061' } },
    },
  });
  addCharge(s);
  const x12 = render(s);
  const lines = segments(x12);
  assert.ok(lines.includes('HL*2*1*22*1~'));
  assert.ok(lines.includes('SBR*P**GRP42******CI~'));
  assert.ok(lines.includes('NM1*IL*1*Doe*John****MI*W123456789~'));
  assert.ok(lines.includes('DMG*D8*19500506*M~'));
  const hl3 = lines.indexOf('HL*3*2*23*0~');
  assert.ok(hl3 > lines.findIndex((l) => l.startsWith('NM1*PR*')));
  assert.deepEqual(lines.slice(hl3, hl3 + 6), ['HL*3*2*23*0~', 'PAT*19~', 'NM1*QC*1*Doe*Jane*Q~', 'N3*9 Elm St~', 'N4*Lenexa*KS*66215~', 'DMG*D8*19800203*F~']);
  assert.ok(hl3 < lines.findIndex((l) => l.startsWith('CLM*')));
});

test('a self subscriber emits no 2000C loop', () => {
  const s = seed();
  addCharge(s);
  assert.equal(elements(render(s), 'HL').length, 2);
  assert.equal(elements(render(s), 'PAT').length, 0);
});

test('every segment ends with ~ and values never carry separators', () => {
  const s = seed({ patient: { lastName: 'O*Brien~Jr', firstName: 'Ma:ry^Ann' }, coverage: { relationship: 'spouse', subscriber: { lastName: 'Ob', firstName: 'Sam' } } });
  addCharge(s, { externalId: 'X*1~2' });
  const lines = segments(render(s));
  for (const l of lines) {
    assert.ok(l.endsWith('~'), l);
    assert.equal(l.indexOf('~'), l.length - 1, l);
  }
  assert.ok(lines.includes('NM1*QC*1*O Brien Jr*Ma ry Ann*Q~'));
  assert.ok(lines.includes('REF*6R*X 1 2~'));
});

test('no 2310B rendering provider when every line is performed by the billing NPI', () => {
  const s = seed();
  addCharge(s, { performingProvider: { lastName: 'Lee', firstName: 'Kim', npi: BILLING_NPI } });
  assert.equal(segments(render(s)).filter((l) => l.startsWith('NM1*82*')).length, 0);
});

test('place of service follows the patient class', () => {
  for (const [patientClass, pos] of [['I', '21'], ['E', '23'], ['O', '22'], ['R', '11']] as const) {
    const s = seed({ encounter: { patientClass } });
    addCharge(s);
    assert.equal(elements(render(s), 'CLM')[0]![5], `${pos}:B:1`);
  }
});

test('X12Writer trims trailing empty elements and components and can drop newlines', () => {
  const w = new X12Writer({ newline: false });
  w.seg('SV1', ['HC', '99213', undefined, ''], '1.00', undefined, '');
  w.seg('HL', '1', '', '20');
  assert.equal(w.toString(), 'SV1*HC:99213*1.00~HL*1**20~');
  assert.equal(w.count, 2);
});

test('HI is derived from the charges: ordered by the lowest sequence, then first appearance, capped at 12', () => {
  const s = seed();
  const d = (sequence: number, code: string) => ({ sequence, code, codingSystem: 'ICD10' as const });
  addCharge(s, { externalId: 'A', diagnoses: [d(3, 'I10'), d(1, 'E11.9')] });
  addCharge(s, { externalId: 'B', code: '36415', diagnoses: [d(2, 'J45.909'), d(2, 'I10')] });
  const x12 = render(s);
  assert.deepEqual(elements(x12, 'HI')[0]!.slice(1), ['ABK:E119', 'ABF:I10', 'ABF:J45909']);
  assert.deepEqual(elements(x12, 'SV1').map((e) => e[7]), ['2:1', '3:2']);
});
