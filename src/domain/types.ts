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
export type DocumentId = Brand<string, 'DocumentId'>;
export type CodingTaskId = Brand<string, 'CodingTaskId'>;
export type ProviderQueryId = Brand<string, 'ProviderQueryId'>;
/** One row of the append-only code log (M1 coding module). */
export type CodeAssignmentId = Brand<string, 'CodeAssignmentId'>;
/** Stable identity of one logical code line across every row that revises it. */
export type CodeLineId = Brand<string, 'CodeLineId'>;

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

export type DiagnosisCodingSystem = 'ICD10' | 'ICD9' | 'OTHER';

/** The encounter's DG1 list: clinical context, written by ingest only. Billing reads the diagnoses a charge carries by value. */
export interface Diagnosis {
  encounterId: EncounterId;
  sequence: number;
  code: string;
  codingSystem: DiagnosisCodingSystem;
  description?: string;
  type: DiagnosisType;
  presentOnAdmission?: string;
}

/**
 * A diagnosis carried by value on a charge. `sequence` is the sequence it had where it
 * was decided (the encounter list for a pass-through FT1, the coder's set at release)
 * and orders the claim's HI list.
 */
export interface ChargeDiagnosis {
  sequence: number;
  code: string;
  codingSystem: DiagnosisCodingSystem;
  description?: string;
}

/**
 * One entry of a claim's HI list, derived by claims/context.ts claimDiagnoses: distinct
 * codes across the attached non-voided charges ordered by (min sequence, first appearance),
 * numbered 1..n. A charge's SV1-7 pointers are the positions of its own codes.
 */
export interface ClaimDiagnosis {
  position: number;
  code: string;
  codingSystem: DiagnosisCodingSystem;
  description?: string;
}

export type ChargeCodeSystem = 'CPT' | 'HCPCS' | 'REV' | 'OTHER';

/** The billable facts of a line, whatever produced it. */
export interface ChargeLine {
  id: ChargeId;
  encounterId: EncounterId;
  /** Line item control number (837P REF*6R). Identity within (encounter, source): FT1-2 for Cerner, `${codeAssignmentId}#${releaseNumber}` for a coder. */
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
  /** By value, in pointer order; at most 4 reach the 837P line. */
  diagnoses: ChargeDiagnosis[];
}

/** An FT1 line billed as Cerner priced it. Redelivery updates it in place. */
export type CernerCharge = ChargeLine & { source: 'cerner_dft' };

/** Created by a coding release from one CodeAssignment row. Immutable after insert except `voidedAt`, set once (trigger in 0002_m1_coding.sql). */
export type CoderCharge = ChargeLine & { source: 'coder'; codeAssignmentId: CodeAssignmentId; voidedAt?: IsoDateTime };

export type Charge = CernerCharge | CoderCharge;
export type ChargeSource = Charge['source'];

/** Derived, never stored: voided if voidedAt; claimed if any ClaimCharge link exists; else unbilled. */
export type ChargeStatus = 'unbilled' | 'claimed' | 'voided';

/** What every charge read returns: the stored charge plus its derived status and claim links. */
export type ChargeState = Charge & { status: ChargeStatus; claimIds: ClaimId[] };

/** The many-to-many link that replaces a single claim id on the charge. Insert-only; written only by claims/build.ts. */
export interface ClaimCharge {
  claimId: ClaimId;
  chargeId: ChargeId;
  attachedAt: IsoDateTime;
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
  /** Set by coding-time rules that address a code line rather than a charge. */
  lineId?: CodeLineId;
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

// Documents: immutable, versioned rows. Writer: ingest/upsert.ts appendDocumentVersion.

export type DocumentKind = 'progress_note' | 'radiology_report' | 'other';
export type DocumentStatus = 'preliminary' | 'final' | 'corrected';

/**
 * One version of a clinical document. Identity (encounterId, externalId, version).
 * Rows are never updated or deleted. "Superseded" is derived: any version below the
 * highest for its (encounterId, externalId).
 */
export interface Document {
  id: DocumentId;
  encounterId: EncounterId;
  /** The InboundMessage this version came from. */
  messageId: MessageId;
  /** TXA-12 (MDM; TXA-13 for a T10 replacement) or OBR-3 filler order number (ORU). */
  externalId: string;
  /** 1-based, contiguous per (encounterId, externalId). */
  version: number;
  kind: DocumentKind;
  status: DocumentStatus;
  title?: string;
  author?: Provider;
  signedAt?: IsoDateTime;
  observedAt?: IsoDateTime;
  /** OBX-5 text lines joined with '\n'. Empty when the note arrived only as an attachment. */
  body: string;
  /** OBX ED payload stored verbatim (base64). Decoding RTF/PDF to text is not M1. */
  attachment?: { mediaType: string; base64: string };
  recordedAt: IsoDateTime;
}

// Coding tasks. Status is written only by coding/state.ts transitionTask.

/**
 * SPEC 7.1. The table is TASK_TRANSITIONS in coding/state.ts. `coded` is never at rest:
 * release moves through it to qa_review or released inside one transaction.
 *
 *   awaiting_documentation ──▶ ready_to_code ──▶ in_progress ──▶ coded ──▶ released
 *             │                                   ▲    │  ▲         │         │
 *             └──▶ on_hold_query ◀────────────────┘    │  │         └─▶ qa_review ─┐
 *                        │                             │  │                        │
 *                        └─────────────────────────────┘  └─ returned_to_coder ◀───┘
 *                                                   (released ──▶ in_progress is a reopen)
 */
export type TaskStatus =
  | 'awaiting_documentation'
  | 'ready_to_code'
  | 'in_progress'
  | 'on_hold_query'
  | 'coded'
  | 'qa_review'
  | 'returned_to_coder'
  | 'released';

export type Specialty = 'primary_care' | 'radiology';

/** What brought the task into existence. Exactly one task per encounter, ever. */
export type TaskOrigin =
  | { kind: 'document'; documentId: DocumentId }
  | { kind: 'discharge'; messageId: MessageId }
  | { kind: 'dft'; messageId: MessageId };

export interface CodingTask {
  id: CodingTaskId;
  encounterId: EncounterId;
  status: TaskStatus;
  /** Unset until the first final document says what kind of work this is. */
  specialty?: Specialty;
  /** Free-form coder handle. Users and roles are M3. */
  assignee?: string;
  origin: TaskOrigin;
  /**
   * Set on tasks born without a final document (A03 or DFT first): the A03-plus-N-hours
   * deadline. Overdue is a read filter on this column; no timer or sweep exists.
   */
  documentationDueAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CodingTaskEvent {
  taskId: CodingTaskId;
  at: IsoDateTime;
  from: TaskStatus | null;
  to: TaskStatus;
  reason: string;
  /** Coder or reviewer handle when a person caused it; absent for feed-driven moves. */
  actor?: string;
  /** For `released`: the release record. For `coded`: acknowledged warnings. Else free-form. */
  detail?: unknown;
}

// Code assignments: append-only log; the current code set is derived by coding/codes.ts.

export type CodeProvenance = 'cerner_dft' | 'coder' | 'ai_suggestion' | 'provider_query';

export interface ProcedureCode {
  kind: 'procedure';
  codeSystem: ChargeCodeSystem;
  code: string;
  modifiers: string[];
  units: number;
  serviceDate: IsoDate;
  /** Absent means "default from the document author" at release. */
  renderingProvider?: Provider;
  /**
   * ICD-10 codes this line is billed for, in pointer order (max 4). Codes, not sequence
   * numbers: re-sequencing diagnoses never edits procedure lines.
   */
  diagnosisCodes: string[];
}

export interface DiagnosisCode {
  kind: 'diagnosis';
  code: string;
  /** Claim sequencing; 1 is principal (837P HI ABK). */
  sequence: number;
  description?: string;
}

/** A modifier is part of a procedure line, not its own kind. */
export type CodeContent = ProcedureCode | DiagnosisCode;

/**
 * One immutable row. A line is the chain of rows sharing lineId, linked by `supersedes`;
 * the line's current row is the one no other row supersedes. UNIQUE(supersedes) in SQL
 * makes a fork impossible.
 */
export interface CodeAssignment {
  id: CodeAssignmentId;
  encounterId: EncounterId;
  lineId: CodeLineId;
  supersedes?: CodeAssignmentId;
  content: CodeContent;
  /** True ends the line: this row says "do not bill `content`". */
  removed: boolean;
  /** Where the code came from. A coder confirming a Cerner line keeps `cerner_dft` and adds a decision. */
  provenance: CodeProvenance;
  /** cerner_dft only: FT1-2 of the line, or `dx:<code>` for an FT1-19 diagnosis. Replay key. */
  sourceRef?: string;
  /** ai_suggestion only (M8). */
  suggestedBy?: { model: string; version: string };
  /** Absent on a proposal awaiting a coder; release refuses while any current row lacks it. */
  decision?: { by: string; at: IsoDateTime; queryId?: ProviderQueryId };
  recordedAt: IsoDateTime;
}

// Provider query: raising one holds the task, answering it resumes the task.

export type QueryChannel = 'in_app' | 'email' | 'cerner_message' | 'verbal';

export interface ProviderQuery {
  id: ProviderQueryId;
  taskId: CodingTaskId;
  question: string;
  raisedBy: string;
  sentTo?: Provider;
  channel: QueryChannel;
  sentAt: IsoDateTime;
  /** Set once. A second identical answer is a no-op; a different one is refused. */
  answer?: { text: string; at: IsoDateTime };
}

// Release: the hand-off record on the `released` task event.

export interface ChargeDelta {
  created: ChargeId[];
  voided: ChargeId[];
  kept: ChargeId[];
}

/** Detail of the `released` task event: the hand-off record SPEC 7.1 asks for. */
export interface ReleaseRecord {
  releaseNumber: number;
  /** Every current, non-removed row at release, as decided. */
  codeSet: CodeAssignment[];
  charges: ChargeDelta;
  /** Set when QA completed the release with notes; the CodingAudit table is post-M1. */
  qaNotes?: string;
}

// Fee schedule: one process-wide schedule until tenancy (M3).

export interface FeeScheduleLine {
  code: string;
  /** Sorted; [] is the modifier-agnostic base price. */
  modifiers: string[];
  /** Per unit. */
  amount: Cents;
  effectiveFrom: IsoDate;
  /** Exclusive. */
  effectiveTo?: IsoDate;
}
