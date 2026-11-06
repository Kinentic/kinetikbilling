import type { Address, CoveragePriority, IsoDate, PatientClass, Sex, SubscriberRelationship } from '../domain/types.ts';
import type { BillingProviderConfig } from './config.ts';
import { pointersFor, type ClaimContext } from './context.ts';
import { X12Writer, formatAmount, interchangeControl, isoToX12Date, x12Date, x12Time } from './x12.ts';

export interface Edi837Controls {
  interchangeControlNumber: number;
  groupControlNumber: number;
  transactionSetControlNumber: number;
  now: Date;
}

export class Missing837DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Missing837DataError';
  }
}

const VERSION = '005010X222A1';
const MAX_DIAGNOSES = 12;

const PLACE_OF_SERVICE: Partial<Record<PatientClass, string>> = { I: '21', E: '23', O: '22' };
const PAYER_RESPONSIBILITY: Record<CoveragePriority, string> = { 1: 'P', 2: 'S', 3: 'T' };
const PATIENT_RELATIONSHIP: Record<Exclude<SubscriberRelationship, 'self'>, string> = { spouse: '01', child: '19', other: 'G8' };
/** 837P DMG03 takes F, M or U. */
const DMG_SEX: Record<Sex, string> = { M: 'M', F: 'F', O: 'U', U: 'U' };

const address = (w: X12Writer, a: Address | undefined): void => {
  if (!a) return;
  w.seg('N3', a.line1, a.line2);
  w.seg('N4', a.city, a.state, a.zip);
};

const demographics = (w: X12Writer, dob: IsoDate | undefined, sex: Sex | undefined): void => {
  if (dob) w.seg('DMG', 'D8', isoToX12Date(dob), sex ? DMG_SEX[sex] : undefined);
};

export const build837P = (ctx: ClaimContext, cfg: BillingProviderConfig, controls: Edi837Controls): string => {
  const { claim, patient, encounter, charges } = ctx;
  const { coverage } = ctx;
  if (!coverage) throw new Missing837DataError(`claim ${claim.id} has no coverage`);
  if (charges.length === 0) throw new Missing837DataError(`claim ${claim.id} has no charges`);

  const { now } = controls;
  const self = coverage.relationship === 'self';
  const diagnoses = ctx.diagnoses.slice(0, MAX_DIAGNOSES);
  const st02 = String(controls.transactionSetControlNumber).padStart(4, '0');

  const w = new X12Writer();
  w.isa({ senderId: cfg.submitterId, receiverId: cfg.receiverId, controlNumber: controls.interchangeControlNumber, now });
  w.seg('GS', 'HC', cfg.submitterId, cfg.receiverId, x12Date(now), x12Time(now), String(controls.groupControlNumber), 'X', VERSION);
  const stIndex = w.count;
  w.seg('ST', '837', st02, VERSION);
  w.seg('BHT', '0019', '00', claim.controlNumber, x12Date(now), x12Time(now), 'CH');

  w.seg('NM1', '41', '2', cfg.submitterName, '', '', '', '', '46', cfg.submitterId);
  w.seg('PER', 'IC', cfg.contactName, 'TE', cfg.contactPhone);
  w.seg('NM1', '40', '2', cfg.receiverName, '', '', '', '', '46', cfg.receiverId);

  w.seg('HL', '1', '', '20', '1');
  w.seg('PRV', 'BI', 'PXC', cfg.taxonomyCode);
  w.seg('NM1', '85', '2', cfg.name, '', '', '', '', 'XX', cfg.npi);
  address(w, cfg.address);
  w.seg('REF', 'EI', cfg.taxId);

  w.seg('HL', '2', '1', '22', self ? '0' : '1');
  w.seg('SBR', PAYER_RESPONSIBILITY[coverage.priority], self ? '18' : '', coverage.groupNumber, '', '', '', '', '', 'CI');
  const sub = coverage.subscriber;
  w.seg('NM1', 'IL', '1', sub.lastName, sub.firstName, sub.middleName, '', '', 'MI', coverage.memberId);
  if (self) {
    address(w, patient.address);
    demographics(w, patient.dob, patient.sex);
  } else {
    address(w, sub.address);
    demographics(w, sub.dob, sub.sex);
  }
  w.seg('NM1', 'PR', '2', coverage.payerName, '', '', '', '', 'PI', coverage.payerId);
  address(w, coverage.payerAddress);

  if (coverage.relationship !== 'self') {
    w.seg('HL', '3', '2', '23', '0');
    w.seg('PAT', PATIENT_RELATIONSHIP[coverage.relationship]);
    w.seg('NM1', 'QC', '1', patient.lastName, patient.firstName, patient.middleName);
    address(w, patient.address);
    demographics(w, patient.dob, patient.sex);
  }

  const pos = PLACE_OF_SERVICE[encounter.patientClass] ?? '11';
  w.seg('CLM', claim.controlNumber, formatAmount(claim.totalCharge), '', '', [pos, 'B', '1'], 'Y', 'A', 'Y', 'Y');
  if (diagnoses.length > 0) {
    w.seg('HI', ...diagnoses.map((d, i) => [i === 0 ? 'ABK' : 'ABF', d.code.replace('.', '')]));
  }
  const rendering = charges.find((c) => c.performingProvider && c.performingProvider.npi !== cfg.npi)?.performingProvider;
  if (rendering) w.seg('NM1', '82', '1', rendering.lastName, rendering.firstName, '', '', '', 'XX', rendering.npi);

  charges.forEach((c, i) => {
    const pointers = pointersFor(c, diagnoses).map(String);
    w.seg('LX', String(i + 1));
    w.seg('SV1', ['HC', c.code, ...c.modifiers.slice(0, 4)], formatAmount(c.amount), 'UN', String(c.units), '', '', pointers.length ? pointers : ['1']);
    w.seg('DTP', '472', 'D8', isoToX12Date(c.serviceDate));
    w.seg('REF', '6R', c.externalId);
  });

  w.seg('SE', String(w.count - stIndex + 1), st02);
  w.seg('GE', '1', String(controls.groupControlNumber));
  w.seg('IEA', '1', interchangeControl(controls.interchangeControlNumber));
  return w.toString();
};
