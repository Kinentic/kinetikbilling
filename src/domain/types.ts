// Domain model for the revenue cycle. Every other module imports from here and
// nothing here imports from anywhere else. Wire formats (HL7, X12, JSON, SQL
// rows) are parsed into these types at the boundary and never leak past it.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PatientId = Brand<string, 'PatientId'>;
export type EncounterId = Brand<string, 'EncounterId'>;
export type CoverageId = Brand<string, 'CoverageId'>;
export type ChargeId = Brand<string, 'ChargeId'>;
export type ClaimId = Brand<string, 'ClaimId'>;
export type MessageId = Brand<string, 'MessageId'>;

/** Whole US cents. Money never travels as a float. */
export type Cents = Brand<number, 'Cents'>;
export const cents = (n: number): Cents => Math.round(n) as Cents;
export const addCents = (a: Cents, b: Cents): Cents => (a + b) as Cents;
export const subCents = (a: Cents, b: Cents): Cents => (a - b) as Cents;
export const ZERO_CENTS = 0 as Cents;

/** ISO 8601 calendar date, YYYY-MM-DD. */
export type IsoDate = Brand<string, 'IsoDate'>;
/** ISO 8601 timestamp with offset or Z. */
export type IsoDateTime = Brand<string, 'IsoDateTime'>;

export type Sex = 'M' | 'F' | 'O' | 'U';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export interface PersonName {
  lastName: string;
  firstName: string;
  middleName?: string;
}

export interface Provider extends PersonName {
  npi: string;
}

/** Identifier as issued by the source system, e.g. Cerner MRN with its assigning authority. */
export interface SourceIdentifier {
  value: string;
  assigningAuthority: string;
  /** HL7 CX.5 identifier type code: MR, AN, PI, SS ... */
  typeCode: string;
}

export interface Patient extends PersonName {
  id: PatientId;
  mrn: SourceIdentifier;
  dob?: IsoDate;
  sex: Sex;
  address?: Address;
  phone?: string;
  ssnLast4?: string;
  /** Set when this record was merged into another (ADT^A40). All encounters move to the survivor. */
  mergedInto?: PatientId;
  updatedAt: IsoDateTime;
}

/** HL7 PV1-2 patient class. */
export type PatientClass = 'I' | 'O' | 'E' | 'P' | 'R' | 'B' | 'C' | 'N' | 'U';

export interface Encounter {
  id: EncounterId;
  patientId: PatientId;
  /** Cerner FIN / PID-18 patient account number. Identity of the encounter within a facility. */
  accountNumber: string;
  facility: string;
  visitNumber?: string;
  patientClass: PatientClass;
  admitAt?: IsoDateTime;
  dischargeAt?: IsoDateTime;
  location?: string;
  attendingProvider?: Provider;
  referringProvider?: Provider;
  financialClass?: string;
  hospitalService?: string;
  updatedAt: IsoDateTime;
}

export type CoveragePriority = 1 | 2 | 3;

/** HL7 IN1-17 relationship of patient to insured. */
export type SubscriberRelationship = 'self' | 'spouse' | 'child' | 'other';

export interface Coverage {
  id: CoverageId;
  encounterId: EncounterId;
  priority: CoveragePriority;
  payerId: string;
  payerName: string;
  payerAddress?: Address;
  planId?: string;
  planName?: string;
  groupNumber?: string;
  /** Policy / member number (IN1-36). */
  memberId: string;
  relationship: SubscriberRelationship;
  subscriber: PersonName & { dob?: IsoDate; sex?: Sex; address?: Address };
  effectiveFrom?: IsoDate;
  effectiveTo?: IsoDate;
}

export interface Guarantor extends PersonName {
  encounterId: EncounterId;
  relationship: SubscriberRelationship;
  address?: Address;
  phone?: string;
}

/** HL7 DG1-6 diagnosis type. */
export type DiagnosisType = 'A' | 'W' | 'F';

export interface Diagnosis {
  encounterId: EncounterId;
  sequence: number;
  code: string;
  codingSystem: 'ICD10' | 'ICD9' | 'OTHER';
  description?: string;
  type: DiagnosisType;
  presentOnAdmission?: string;
}

export type ChargeCodeSystem = 'CPT' | 'HCPCS' | 'REV' | 'OTHER';

export type ChargeStatus = 'unbilled' | 'claimed' | 'voided';

export interface Charge {
  id: ChargeId;
  encounterId: EncounterId;
  /** FT1-2 transaction id. Identity of the charge within its encounter; redelivery is an update. */
  externalId: string;
  /** FT1-6: CG charge, CD credit (a reversal, negative amount). */
  transactionType: 'CG' | 'CD';
  serviceDate: IsoDate;
  postedDate?: IsoDate;
  codeSystem: ChargeCodeSystem;
  code: string;
  modifiers: string[];
  description?: string;
  units: number;
  /** Extended amount for the line (units × unit price), signed. */
  amount: Cents;
  department?: string;
  revenueCode?: string;
  performingProvider?: Provider;
  orderingProvider?: Provider;
  /** 1-based indexes into the encounter's diagnosis list, as the claim line pointers. */
  diagnosisPointers: number[];
  status: ChargeStatus;
  claimId?: ClaimId;
}

/**
 * Claim lifecycle. Transitions are the table in claims/state.ts; nothing else
 * assigns a status.
 *
 *   draft ─scrub─▶ ready ─submit─▶ submitted ─ack─▶ accepted ─remit─▶ paid | partially_paid | denied ─▶ closed
 *     ▲               │                 │
 *     └── scrub_failed┘                 └─ rejected ─▶ draft
 */
export type ClaimStatus =
  | 'draft'
  | 'scrub_failed'
  | 'ready'
  | 'submitted'
  | 'rejected'
  | 'accepted'
  | 'paid'
  | 'partially_paid'
  | 'denied'
  | 'closed';

export type ClaimType = 'professional' | 'institutional';

export interface Claim {
  id: ClaimId;
  encounterId: EncounterId;
  patientId: PatientId;
  coverageId: CoverageId;
  type: ClaimType;
  status: ClaimStatus;
  /** Patient control number sent in CLM01 and matched on the 835 CLP01. */
  controlNumber: string;
  totalCharge: Cents;
  totalPaid: Cents;
  totalAdjusted: Cents;
  patientResponsibility: Cents;
  payerClaimControlNumber?: string;
  submittedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ClaimEvent {
  claimId: ClaimId;
  at: IsoDateTime;
  from: ClaimStatus | null;
  to: ClaimStatus;
  reason: string;
  /** Free-form structured detail: scrub violations, 835 CLP data, 277 codes. */
  detail?: unknown;
}

export type ScrubSeverity = 'error' | 'warning';

export interface ScrubViolation {
  rule: string;
  severity: ScrubSeverity;
  message: string;
  chargeId?: ChargeId;
}

/** Claim adjustment group codes as on an 835 CAS segment. */
export type AdjustmentGroup = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';

export interface Adjustment {
  group: AdjustmentGroup;
  reasonCode: string;
  amount: Cents;
}

/** One adjudicated claim from a remittance (835 CLP + CAS), or the same posted by hand. */
export interface Remittance {
  controlNumber: string;
  payerClaimControlNumber?: string;
  /** 835 CLP02: 1 primary processed, 2 secondary, 3 tertiary, 4 denied, 22 reversal. */
  statusCode: '1' | '2' | '3' | '4' | '22';
  chargedAmount: Cents;
  paidAmount: Cents;
  patientResponsibility: Cents;
  adjustments: Adjustment[];
  checkNumber?: string;
  paidAt?: IsoDate;
}

export interface Payment {
  claimId: ClaimId;
  at: IsoDateTime;
  source: '835' | 'manual';
  remittance: Remittance;
}

export type InboundMessageStatus = 'accepted' | 'error' | 'duplicate' | 'unsupported';

/** Every HL7 message received, verbatim, for audit and replay. */
export interface InboundMessage {
  id: MessageId;
  controlId: string;
  sendingApplication: string;
  sendingFacility: string;
  messageType: string;
  triggerEvent: string;
  receivedAt: IsoDateTime;
  raw: string;
  status: InboundMessageStatus;
  error?: string;
}
