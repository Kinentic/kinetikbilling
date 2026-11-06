import type { ChargeId, ChargeState, CodeLineId, IsoDateTime, ScrubSeverity, ScrubViolation } from '../domain/types.ts';
import type { BillingProviderConfig } from './config.ts';
import type { ClaimContext } from './context.ts';

/** A rule over some read model. Claim-time rules use ClaimContext; coding-time edits reuse rule() and when() over their own context. */
export interface ScrubRule<Ctx = ClaimContext> {
  id: string;
  severity: ScrubSeverity;
  check(ctx: Ctx, cfg: BillingProviderConfig): ScrubViolation[];
}

export type Finding = { message: string; chargeId?: ChargeId; lineId?: CodeLineId };

export const rule = <Ctx>(id: string, severity: ScrubSeverity, find: (ctx: Ctx, cfg: BillingProviderConfig) => Finding[]): ScrubRule<Ctx> => ({
  id,
  severity,
  check: (ctx, cfg) => find(ctx, cfg).map((f) => ({ rule: id, severity, ...f })),
});

const perCharge = (id: string, severity: ScrubSeverity, find: (c: ChargeState, ctx: ClaimContext) => string | undefined): ScrubRule =>
  rule<ClaimContext>(id, severity, (ctx) => ctx.charges.flatMap((c) => {
    const message = find(c, ctx);
    return message ? [{ message: `${c.externalId}: ${message}`, chargeId: c.id }] : [];
  }));

export const when = (cond: boolean, message: string): Finding[] => (cond ? [{ message }] : []);

export const ICD10 = /^[A-Z][0-9][0-9AB]\.?[0-9A-Z]{0,4}$/;

/** NPI check digit: Luhn over the 15 digits formed by prefixing 80840. */
export const isValidNpi = (npi: string): boolean => {
  if (!/^\d{10}$/.test(npi)) return false;
  let sum = 0;
  const digits = `80840${npi}`;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

const datePart = (t: IsoDateTime): string => t.slice(0, 10);

export const RULES: readonly ScrubRule[] = [
  rule('charges-present', 'error', (ctx) => when(ctx.charges.length === 0, 'claim has no charges')),
  rule('total-positive', 'error', (ctx) => when(ctx.charges.length > 0 && ctx.claim.totalCharge <= 0, `total charge ${ctx.claim.totalCharge} cents is not positive`)),
  rule('coverage-present', 'error', (ctx) => when(!ctx.coverage, 'claim has no coverage')),
  rule('coverage-ids', 'error', (ctx) => [
    ...when(!!ctx.coverage && !ctx.coverage.memberId.trim(), 'coverage is missing the member id'),
    ...when(!!ctx.coverage && !ctx.coverage.payerId.trim(), 'coverage is missing the payer id'),
  ]),
  rule('diagnoses-present', 'error', (ctx) => when(ctx.diagnoses.length === 0, 'claim has no diagnoses')),
  rule('diagnosis-icd10-shape', 'error', (ctx) =>
    ctx.diagnoses.filter((d) => !ICD10.test(d.code)).map((d) => ({ message: `diagnosis ${d.position} code ${d.code} is not ICD-10 shaped` }))),
  rule('claim-dx-count', 'error', (ctx) => when(ctx.diagnoses.length > 12, `${ctx.diagnoses.length} diagnoses; the 837P claim carries at most 12`)),
  rule('patient-demographics', 'warning', (ctx) => [
    ...when(!ctx.patient.dob, 'patient date of birth is missing'),
    ...when(ctx.patient.sex === 'U', 'patient sex is unknown'),
  ]),
  rule('patient-address', 'error', (ctx) => when(!ctx.patient.address, 'patient address is missing')),
  perCharge('charge-service-date', 'error', (c, ctx) => {
    if (!c.serviceDate) return 'service date is missing';
    const { admitAt, dischargeAt } = ctx.encounter;
    if (admitAt && dischargeAt && (c.serviceDate < datePart(admitAt) || c.serviceDate > datePart(dischargeAt))) {
      return `service date ${c.serviceDate} is outside the encounter ${datePart(admitAt)}..${datePart(dischargeAt)}`;
    }
    return undefined;
  }),
  perCharge('charge-dx-count', 'error', (c) => (c.diagnoses.length > 4 ? `${c.diagnoses.length} diagnoses; the 837P line carries at most 4` : undefined)),
  perCharge('charge-dx-empty', 'warning', (c) => (c.diagnoses.length === 0 ? 'no diagnoses; the line pointer defaults to 1' : undefined)),
  perCharge('charge-performing-provider-missing', 'warning', (c) => (c.performingProvider ? undefined : 'performing provider is missing')),
  perCharge('charge-performing-provider-npi', 'error', (c) =>
    c.performingProvider && !isValidNpi(c.performingProvider.npi) ? `performing provider NPI ${c.performingProvider.npi} is invalid` : undefined),
  perCharge('charge-modifiers', 'error', (c) => (c.modifiers.length > 4 ? `${c.modifiers.length} modifiers; at most 4` : undefined)),
  rule('billing-provider-npi', 'error', (_ctx, cfg) => when(!isValidNpi(cfg.npi), `billing provider NPI ${cfg.npi} is invalid`)),
  rule('duplicate-charge-lines', 'warning', (ctx) => {
    const seen = new Set<string>();
    return ctx.charges.flatMap((c) => {
      const key = [c.transactionType, c.code, c.modifiers.join(':'), c.serviceDate, c.performingProvider?.npi ?? ''].join('|');
      if (!seen.has(key)) { seen.add(key); return []; }
      return [{ message: `${c.externalId}: duplicates another line (${c.code} on ${c.serviceDate})`, chargeId: c.id }];
    });
  }),
];

export const scrubClaim = (ctx: ClaimContext, cfg: BillingProviderConfig): ScrubViolation[] => RULES.flatMap((r) => r.check(ctx, cfg));

export const hasErrors = (violations: readonly ScrubViolation[]): boolean => violations.some((v) => v.severity === 'error');
