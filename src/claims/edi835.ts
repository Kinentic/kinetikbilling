import { cents, type Adjustment, type AdjustmentGroup, type Cents, type IsoDate, type Remittance } from '../domain/types.ts';

export class Edi835ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Edi835ParseError';
  }
}

const GROUPS: readonly AdjustmentGroup[] = ['CO', 'PR', 'OA', 'PI', 'CR'];
/** CLP02 codes 19-21 are 1-3 with the claim forwarded to the next payer; posting treats them alike. */
const CLAIM_STATUS: Record<string, Remittance['statusCode']> = { '1': '1', '2': '2', '3': '3', '4': '4', '22': '22', '19': '1', '20': '2', '21': '3' };
const MAX_CAS_TRIPLES = 6;

/** Exact decimal dollars to cents; floats never touch the amount. */
export const dollarsToCents = (raw: string): Cents => {
  const m = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(raw.trim());
  if (!m || (m[2] === '' && !m[3])) throw new Edi835ParseError(`invalid amount: ${JSON.stringify(raw)}`);
  const whole = Number(m[2] || '0');
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  return cents((m[1] ? -1 : 1) * (whole * 100 + frac));
};

const toIsoDate = (raw: string): IsoDate => {
  if (!/^\d{8}$/.test(raw)) throw new Edi835ParseError(`invalid date: ${JSON.stringify(raw)}`);
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` as IsoDate;
};

interface Delimiters { element: string; component: string; segment: string }

const readDelimiters = (raw: string): Delimiters => {
  if (!raw.startsWith('ISA') || raw.length < 106) throw new Edi835ParseError('interchange does not start with an ISA segment');
  const element = raw[3]!;
  let at = 3;
  for (let i = 0; i < 15; i++) {
    at = raw.indexOf(element, at + 1);
    if (at < 0) throw new Edi835ParseError('ISA segment has fewer than 16 elements');
  }
  const component = raw[at + 1];
  const segment = raw[at + 2];
  if (!component || !segment || segment === element) throw new Edi835ParseError('ISA16 or the segment terminator is missing');
  return { element, component, segment };
};

export const parse835 = (raw: string): Remittance[] => {
  const text = raw.replace(/^﻿/, '').trimStart();
  const d = readDelimiters(text);
  const segments = text.split(d.segment).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => s.split(d.element));
  if (segments.at(-1)?.[0] !== 'IEA') throw new Edi835ParseError('interchange has no IEA trailer');

  const out: Remittance[] = [];
  let checkNumber: string | undefined;
  let paidAt: IsoDate | undefined;
  let current: Remittance | undefined;
  const el = (s: string[], i: number): string => s[i] ?? '';

  for (const s of segments) {
    switch (s[0]) {
      case 'ST':
        checkNumber = undefined;
        paidAt = undefined;
        current = undefined;
        break;
      case 'BPR':
        if (el(s, 16)) paidAt = toIsoDate(el(s, 16));
        break;
      case 'TRN':
        checkNumber = el(s, 2) || undefined;
        break;
      case 'CLP': {
        const statusCode = CLAIM_STATUS[el(s, 2)];
        if (!el(s, 1)) throw new Edi835ParseError('CLP01 patient control number is missing');
        if (!statusCode) throw new Edi835ParseError(`CLP ${el(s, 1)}: unsupported claim status ${JSON.stringify(el(s, 2))}`);
        current = {
          controlNumber: el(s, 1),
          statusCode,
          chargedAmount: dollarsToCents(el(s, 3)),
          paidAmount: dollarsToCents(el(s, 4)),
          patientResponsibility: el(s, 5) ? dollarsToCents(el(s, 5)) : cents(0),
          adjustments: [],
          ...(el(s, 7) ? { payerClaimControlNumber: el(s, 7) } : {}),
          ...(checkNumber ? { checkNumber } : {}),
          ...(paidAt ? { paidAt } : {}),
        };
        out.push(current);
        break;
      }
      case 'CAS': {
        if (!current) throw new Edi835ParseError('CAS segment outside a CLP claim');
        const group = el(s, 1) as AdjustmentGroup;
        if (!GROUPS.includes(group)) throw new Edi835ParseError(`CAS: unknown adjustment group ${JSON.stringify(el(s, 1))}`);
        for (let t = 0; t < MAX_CAS_TRIPLES; t++) {
          const reasonCode = el(s, 2 + t * 3);
          if (!reasonCode) continue;
          const adjustment: Adjustment = { group, reasonCode, amount: dollarsToCents(el(s, 3 + t * 3)) };
          current.adjustments.push(adjustment);
        }
        break;
      }
      case 'SE':
        current = undefined;
        break;
    }
  }
  return out;
};
