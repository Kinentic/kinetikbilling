import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Edi835ParseError, dollarsToCents, parse835 } from './edi835.ts';
import { SAMPLE_835 } from './testkit.ts';

test('parse835 reads every CLP with claim and service level CAS in exact cents', () => {
  assert.deepEqual(parse835(SAMPLE_835), [
    {
      controlNumber: 'FIN000123-1', statusCode: '1', chargedAmount: 15550, paidAmount: 10000, patientResponsibility: 2500,
      payerClaimControlNumber: 'PCN001', checkNumber: 'EFT0042', paidAt: '2026-11-03',
      adjustments: [
        { group: 'CO', reasonCode: '45', amount: 3000 },
        { group: 'PR', reasonCode: '2', amount: 2000 },
        { group: 'PR', reasonCode: '3', amount: 500 },
        { group: 'OA', reasonCode: '23', amount: 50 },
      ],
    },
    {
      controlNumber: 'FIN000456-1', statusCode: '4', chargedAmount: 8000, paidAmount: 0, patientResponsibility: 0,
      payerClaimControlNumber: 'PCN002', checkNumber: 'EFT0042', paidAt: '2026-11-03',
      adjustments: [{ group: 'CO', reasonCode: '29', amount: 5000 }, { group: 'CO', reasonCode: '45', amount: 3000 }],
    },
  ]);
});

test('parse835 takes delimiters from the ISA, not from assumptions', () => {
  const custom = SAMPLE_835.replaceAll('\r\n', '').replaceAll('*', '|').replaceAll('~', '!').replace('|P|:!', '|P|>!');
  const [first] = parse835(custom);
  assert.equal(first!.controlNumber, 'FIN000123-1');
  assert.equal(first!.adjustments.length, 4);
});

test('dollar strings convert to cents without floating point', () => {
  assert.equal(dollarsToCents('0.29'), 29);
  assert.equal(dollarsToCents('-12.5'), -1250);
  assert.equal(dollarsToCents('100'), 10000);
  assert.equal(dollarsToCents('.07'), 7);
  assert.throws(() => dollarsToCents('1.005'), Edi835ParseError);
  assert.throws(() => dollarsToCents('12a'), Edi835ParseError);
});

test('a malformed interchange throws Edi835ParseError', () => {
  assert.throws(() => parse835('GS*HP*X~'), Edi835ParseError);
  assert.throws(() => parse835(SAMPLE_835.replace(/IEA[^~]*~\r\n$/, '')), Edi835ParseError);
  assert.throws(() => parse835(SAMPLE_835.replace('CLP*FIN000456-1*4*80.00', 'CLP*FIN000456-1*4*eighty')), Edi835ParseError);
  assert.throws(() => parse835(SAMPLE_835.replace('CAS*OA*23', 'CAS*ZZ*23')), Edi835ParseError);
});
