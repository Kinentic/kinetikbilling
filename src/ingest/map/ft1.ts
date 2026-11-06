import { cents, type ChargeCodeSystem, type ChargeLine, type IsoDate } from '../../domain/types.ts';
import { comp, parseHl7Date, repComp, reps, type Hl7Segment } from '../../hl7/index.ts';
import { IngestError } from '../handler.ts';
import { codingSystemOf, normalizeDxCode, type DiagnosisRef } from './dg1.ts';
import { parseMoney } from './money.ts';
import { nonEmpty } from './text.ts';
import { mapXcn } from './xcn.ts';

export type MappedCharge = Omit<ChargeLine, 'id' | 'encounterId' | 'diagnoses'> & {
  /** FT1-19 codes; upsertCharges gives each its sequence on the encounter's list and copies it onto the charge by value. */
  diagnosisRefs: DiagnosisRef[];
};

export interface Ft1Context {
  controlId: string;
  /** MSH-7 as a date, the last service-date fallback. */
  messageDate: IsoDate | undefined;
}

const CODE_SYSTEMS: Readonly<Record<string, ChargeCodeSystem>> = {
  CPT: 'CPT', C4: 'CPT', CPT4: 'CPT',
  HCPCS: 'HCPCS', HCPC: 'HCPCS', 'HCPCS-II': 'HCPCS',
};
const codeSystemOf = (ce3: string): ChargeCodeSystem => CODE_SYSTEMS[ce3.trim().toUpperCase()] ?? 'OTHER';

function units(ft1: Hl7Segment): number {
  const text = comp(ft1, 10).trim();
  const n = Number(text);
  return text === '' || !Number.isFinite(n) ? 1 : n;
}

/** Undefined when FT1-6 is neither CG nor CD: that line is skipped. */
export function mapFt1(ft1: Hl7Segment, ctx: Ft1Context): MappedCharge | undefined {
  const transactionType = comp(ft1, 6).trim();
  if (transactionType !== 'CG' && transactionType !== 'CD') return undefined;
  const externalId = nonEmpty(comp(ft1, 2)) ?? `${ctx.controlId}-${comp(ft1, 1).trim()}`;
  const where = `FT1 ${externalId}`;

  const procedure = nonEmpty(comp(ft1, 25, 1));
  const transactionCode = comp(ft1, 7, 1).trim();
  const codeField = procedure ? 25 : 7;
  const code = procedure ?? transactionCode;
  if (!code) throw new IngestError(`${where}: FT1-25 and FT1-7 carry no charge code`);

  const serviceDate = parseHl7Date(comp(ft1, 4)) ?? parseHl7Date(comp(ft1, 5)) ?? ctx.messageDate;
  if (!serviceDate) throw new IngestError(`${where}: FT1-4, FT1-5 and MSH-7 carry no service date`);

  const qty = units(ft1);
  const extended = parseMoney(comp(ft1, 11));
  const unitPrice = parseMoney(comp(ft1, 12));
  const amount = extended ?? (unitPrice === undefined ? undefined : cents(unitPrice * qty));
  if (amount === undefined) throw new IngestError(`${where}: FT1-11 and FT1-12 carry no amount`);
  // Sites differ on whether credits arrive negative, so FT1-6 alone decides the sign.
  const signed = cents(transactionType === 'CD' ? -Math.abs(amount) : Math.abs(amount));

  return {
    externalId,
    transactionType,
    serviceDate,
    postedDate: parseHl7Date(comp(ft1, 5)),
    codeSystem: codeSystemOf(comp(ft1, codeField, 3)),
    code,
    modifiers: reps(ft1, 26).map((r) => repComp(r, 1).trim()).filter((m) => m !== ''),
    description: nonEmpty(comp(ft1, 8)) ?? nonEmpty(comp(ft1, codeField, 2)),
    units: qty,
    amount: signed === 0 ? cents(0) : signed,
    department: nonEmpty(comp(ft1, 13, 1)),
    revenueCode: procedure && /^\d{4}$/.test(transactionCode) ? transactionCode : undefined,
    performingProvider: mapXcn(ft1, 20),
    orderingProvider: mapXcn(ft1, 21),
    diagnosisRefs: reps(ft1, 19)
      .map((r) => ({ code: normalizeDxCode(repComp(r, 1)), description: nonEmpty(repComp(r, 2)), codingSystem: codingSystemOf(repComp(r, 3)) }))
      .filter((d) => d.code !== ''),
  };
}
