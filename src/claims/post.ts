import type { Store } from '../db/store.ts';
import { nowIso } from '../domain/ids.ts';
import { cents, type AdjustmentGroup, type Cents, type Claim, type ClaimStatus, type Remittance } from '../domain/types.ts';
import { ClaimNotFoundError, transition } from './state.ts';

/** Groups that reduce what the payer owes without billing the patient. */
const WRITE_OFF: readonly AdjustmentGroup[] = ['CO', 'OA', 'PI', 'CR'];

const sum = (xs: readonly number[]): Cents => cents(xs.reduce((a, b) => a + b, 0));

const sameRemit = (a: Remittance, b: Remittance): boolean =>
  a.payerClaimControlNumber === b.payerClaimControlNumber && a.checkNumber === b.checkNumber && a.statusCode === b.statusCode;

export const outstanding = (c: Claim): Cents => cents(c.totalCharge - c.totalPaid - c.totalAdjusted - c.patientResponsibility);

export const postRemittance = (store: Store, remit: Remittance, source: '835' | 'manual'): Claim => store.transaction(() => {
  const claim = store.findClaimByControlNumber(remit.controlNumber);
  if (!claim) throw new ClaimNotFoundError(`control number ${remit.controlNumber}`);
  if (store.listPayments(claim.id).some((p) => sameRemit(p.remittance, remit))) return claim;

  const prCas = remit.adjustments.filter((a) => a.group === 'PR');
  const paid = remit.paidAmount;
  const adjusted = sum(remit.adjustments.filter((a) => WRITE_OFF.includes(a.group)).map((a) => a.amount));
  const patient = prCas.length ? sum(prCas.map((a) => a.amount)) : remit.patientResponsibility;
  // A reversal (CLP02 22) undoes an earlier posting; payers send it negated or not, so take magnitudes.
  const sign = remit.statusCode === '22' ? -1 : 1;
  const apply = (total: Cents, delta: Cents): Cents => cents(total + (sign === -1 ? -Math.abs(delta) : delta));

  const updated: Claim = {
    ...claim,
    totalPaid: apply(claim.totalPaid, paid),
    totalAdjusted: apply(claim.totalAdjusted, adjusted),
    patientResponsibility: apply(claim.patientResponsibility, patient),
    ...(remit.payerClaimControlNumber ? { payerClaimControlNumber: remit.payerClaimControlNumber } : {}),
  };
  const balance = outstanding(updated);
  const to: ClaimStatus = remit.statusCode === '4' ? 'denied' : remit.statusCode === '22' ? 'partially_paid' : balance <= 0 ? 'paid' : 'partially_paid';

  store.savePayment({ claimId: claim.id, at: nowIso(), source, remittance: remit });
  return transition(store, updated, to, `remittance ${remit.statusCode}`, { source, remittance: remit, outstanding: balance });
});
