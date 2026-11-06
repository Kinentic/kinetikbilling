// SQLite persistence. Rows are mapped to domain types here and nowhere else;
// callers never see column names. One Store per process; node:sqlite is
// synchronous, so every method runs to completion before the next starts.

import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  Charge, ChargeId, ChargeStatus, Claim, ClaimEvent, ClaimId, ClaimStatus, Coverage, CoverageId,
  Diagnosis, Encounter, EncounterId, Guarantor, InboundMessage, InboundMessageStatus, MessageId,
  Patient, PatientId, Payment,
} from '../domain/types.ts';

type Row = Record<string, SQLInputValue>;

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const unjson = <T>(s: unknown): T | undefined => (typeof s === 'string' ? (JSON.parse(s) as T) : undefined);
const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));
/** Drop undefined keys so exactOptionalPropertyTypes-typed objects round-trip cleanly. */
const compact = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

const patientFromRow = (r: Row): Patient => compact({
  id: r.id as PatientId,
  mrn: { value: r.mrn_value as string, assigningAuthority: r.mrn_authority as string, typeCode: r.mrn_type as string },
  lastName: r.last_name as string,
  firstName: r.first_name as string,
  middleName: opt(r.middle_name),
  dob: opt(r.dob),
  sex: r.sex as Patient['sex'],
  address: unjson(r.address_json),
  phone: opt(r.phone),
  ssnLast4: opt(r.ssn_last4),
  mergedInto: opt(r.merged_into),
  updatedAt: r.updated_at as Patient['updatedAt'],
});

const encounterFromRow = (r: Row): Encounter => compact({
  id: r.id as EncounterId,
  patientId: r.patient_id as PatientId,
  accountNumber: r.account_number as string,
  facility: r.facility as string,
  visitNumber: opt(r.visit_number),
  patientClass: r.patient_class as Encounter['patientClass'],
  admitAt: opt(r.admit_at),
  dischargeAt: opt(r.discharge_at),
  location: opt(r.location),
  attendingProvider: unjson(r.attending_json),
  referringProvider: unjson(r.referring_json),
  financialClass: opt(r.financial_class),
  hospitalService: opt(r.hospital_service),
  updatedAt: r.updated_at as Encounter['updatedAt'],
});

const coverageFromRow = (r: Row): Coverage => compact({
  id: r.id as CoverageId,
  encounterId: r.encounter_id as EncounterId,
  priority: r.priority as Coverage['priority'],
  payerId: r.payer_id as string,
  payerName: r.payer_name as string,
  payerAddress: unjson(r.payer_address_json),
  planId: opt(r.plan_id),
  planName: opt(r.plan_name),
  groupNumber: opt(r.group_number),
  memberId: r.member_id as string,
  relationship: r.relationship as Coverage['relationship'],
  subscriber: unjson<Coverage['subscriber']>(r.subscriber_json)!,
  effectiveFrom: opt(r.effective_from),
  effectiveTo: opt(r.effective_to),
});

const guarantorFromRow = (r: Row): Guarantor => compact({
  encounterId: r.encounter_id as EncounterId,
  lastName: r.last_name as string,
  firstName: r.first_name as string,
  middleName: opt(r.middle_name),
  relationship: r.relationship as Guarantor['relationship'],
  address: unjson(r.address_json),
  phone: opt(r.phone),
});

const diagnosisFromRow = (r: Row): Diagnosis => compact({
  encounterId: r.encounter_id as EncounterId,
  sequence: r.sequence as number,
  code: r.code as string,
  codingSystem: r.coding_system as Diagnosis['codingSystem'],
  description: opt(r.description),
  type: r.type as Diagnosis['type'],
  presentOnAdmission: opt(r.poa),
});

const chargeFromRow = (r: Row): Charge => compact({
  id: r.id as ChargeId,
  encounterId: r.encounter_id as EncounterId,
  externalId: r.external_id as string,
  transactionType: r.transaction_type as Charge['transactionType'],
  serviceDate: r.service_date as Charge['serviceDate'],
  postedDate: opt(r.posted_date),
  codeSystem: r.code_system as Charge['codeSystem'],
  code: r.code as string,
  modifiers: unjson<string[]>(r.modifiers_json) ?? [],
  description: opt(r.description),
  units: r.units as number,
  amount: r.amount as Charge['amount'],
  department: opt(r.department),
  revenueCode: opt(r.revenue_code),
  performingProvider: unjson(r.performing_json),
  orderingProvider: unjson(r.ordering_json),
  diagnosisPointers: unjson<number[]>(r.dx_pointers_json) ?? [],
  status: r.status as ChargeStatus,
  claimId: opt(r.claim_id),
});

const claimFromRow = (r: Row): Claim => compact({
  id: r.id as ClaimId,
  encounterId: r.encounter_id as EncounterId,
  patientId: r.patient_id as PatientId,
  coverageId: r.coverage_id as CoverageId,
  type: r.type as Claim['type'],
  status: r.status as ClaimStatus,
  controlNumber: r.control_number as string,
  totalCharge: r.total_charge as Claim['totalCharge'],
  totalPaid: r.total_paid as Claim['totalPaid'],
  totalAdjusted: r.total_adjusted as Claim['totalAdjusted'],
  patientResponsibility: r.patient_responsibility as Claim['patientResponsibility'],
  payerClaimControlNumber: opt(r.payer_claim_control_number),
  submittedAt: opt(r.submitted_at),
  createdAt: r.created_at as Claim['createdAt'],
  updatedAt: r.updated_at as Claim['updatedAt'],
});

const claimEventFromRow = (r: Row): ClaimEvent => compact({
  claimId: r.claim_id as ClaimId,
  at: r.at as ClaimEvent['at'],
  from: (r.from_status as ClaimStatus | null) ?? null,
  to: r.to_status as ClaimStatus,
  reason: r.reason as string,
  detail: unjson(r.detail_json),
});

const paymentFromRow = (r: Row): Payment => ({
  claimId: r.claim_id as ClaimId,
  at: r.at as Payment['at'],
  source: r.source as Payment['source'],
  remittance: unjson<Payment['remittance']>(r.remittance_json)!,
});

const messageFromRow = (r: Row): InboundMessage => compact({
  id: r.id as MessageId,
  controlId: r.control_id as string,
  sendingApplication: r.sending_application as string,
  sendingFacility: r.sending_facility as string,
  messageType: r.message_type as string,
  triggerEvent: r.trigger_event as string,
  receivedAt: r.received_at as InboundMessage['receivedAt'],
  raw: r.raw as string,
  status: r.status as InboundMessageStatus,
  error: opt(r.error),
});

export interface ListClaimsFilter { status?: ClaimStatus; encounterId?: EncounterId; patientId?: PatientId }
export interface ListChargesFilter { encounterId?: EncounterId; status?: ChargeStatus; claimId?: ClaimId }

export class Store {
  readonly #db: DatabaseSync;

  /** path ':memory:' gives an isolated in-memory database for tests. */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }

  close(): void { this.#db.close(); }

  /** Runs fn atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.#inTx) return fn();
    this.#inTx = true;
    this.#db.exec('begin');
    try {
      const out = fn();
      this.#db.exec('commit');
      return out;
    } catch (e) {
      this.#db.exec('rollback');
      throw e;
    } finally {
      this.#inTx = false;
    }
  }
  #inTx = false;

  #one<T>(sql: string, params: SQLInputValue[], map: (r: Row) => T): T | undefined {
    const r = this.#db.prepare(sql).get(...params) as Row | undefined;
    return r ? map(r) : undefined;
  }
  #many<T>(sql: string, params: SQLInputValue[], map: (r: Row) => T): T[] {
    return (this.#db.prepare(sql).all(...params) as Row[]).map(map);
  }
  #run(sql: string, params: SQLInputValue[]): void { this.#db.prepare(sql).run(...params); }

  // Patients

  getPatient(id: PatientId): Patient | undefined {
    return this.#one('select * from patients where id = ?', [id], patientFromRow);
  }
  findPatientByMrn(value: string, assigningAuthority: string): Patient | undefined {
    return this.#one('select * from patients where mrn_value = ? and mrn_authority = ?', [value, assigningAuthority], patientFromRow);
  }
  listPatients(limit = 100, offset = 0): Patient[] {
    return this.#many('select * from patients order by last_name, first_name limit ? offset ?', [limit, offset], patientFromRow);
  }
  savePatient(p: Patient): void {
    this.#run(`insert into patients (id, mrn_value, mrn_authority, mrn_type, last_name, first_name, middle_name, dob, sex, address_json, phone, ssn_last4, merged_into, updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set mrn_value=excluded.mrn_value, mrn_authority=excluded.mrn_authority, mrn_type=excluded.mrn_type,
        last_name=excluded.last_name, first_name=excluded.first_name, middle_name=excluded.middle_name, dob=excluded.dob, sex=excluded.sex,
        address_json=excluded.address_json, phone=excluded.phone, ssn_last4=excluded.ssn_last4, merged_into=excluded.merged_into, updated_at=excluded.updated_at`,
      [p.id, p.mrn.value, p.mrn.assigningAuthority, p.mrn.typeCode, p.lastName, p.firstName, p.middleName ?? null, p.dob ?? null, p.sex,
        json(p.address), p.phone ?? null, p.ssnLast4 ?? null, p.mergedInto ?? null, p.updatedAt]);
  }
  /** Moves every encounter and claim from merged to survivor and marks merged as absorbed. */
  mergePatients(survivorId: PatientId, mergedId: PatientId, at: Patient['updatedAt']): void {
    this.transaction(() => {
      this.#run('update encounters set patient_id = ?, updated_at = ? where patient_id = ?', [survivorId, at, mergedId]);
      this.#run('update claims set patient_id = ?, updated_at = ? where patient_id = ?', [survivorId, at, mergedId]);
      this.#run('update patients set merged_into = ?, updated_at = ? where id = ?', [survivorId, at, mergedId]);
    });
  }

  // Encounters

  getEncounter(id: EncounterId): Encounter | undefined {
    return this.#one('select * from encounters where id = ?', [id], encounterFromRow);
  }
  findEncounter(facility: string, accountNumber: string): Encounter | undefined {
    return this.#one('select * from encounters where facility = ? and account_number = ?', [facility, accountNumber], encounterFromRow);
  }
  listEncounters(patientId?: PatientId): Encounter[] {
    return patientId
      ? this.#many('select * from encounters where patient_id = ? order by admit_at', [patientId], encounterFromRow)
      : this.#many('select * from encounters order by admit_at desc limit 500', [], encounterFromRow);
  }
  saveEncounter(e: Encounter): void {
    this.#run(`insert into encounters (id, patient_id, account_number, facility, visit_number, patient_class, admit_at, discharge_at, location, attending_json, referring_json, financial_class, hospital_service, updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set patient_id=excluded.patient_id, account_number=excluded.account_number, facility=excluded.facility, visit_number=excluded.visit_number,
        patient_class=excluded.patient_class, admit_at=excluded.admit_at, discharge_at=excluded.discharge_at, location=excluded.location, attending_json=excluded.attending_json,
        referring_json=excluded.referring_json, financial_class=excluded.financial_class, hospital_service=excluded.hospital_service, updated_at=excluded.updated_at`,
      [e.id, e.patientId, e.accountNumber, e.facility, e.visitNumber ?? null, e.patientClass, e.admitAt ?? null, e.dischargeAt ?? null, e.location ?? null,
        json(e.attendingProvider), json(e.referringProvider), e.financialClass ?? null, e.hospitalService ?? null, e.updatedAt]);
  }

  // Coverages

  getCoverage(id: CoverageId): Coverage | undefined {
    return this.#one('select * from coverages where id = ?', [id], coverageFromRow);
  }
  listCoverages(encounterId: EncounterId): Coverage[] {
    return this.#many('select * from coverages where encounter_id = ? order by priority', [encounterId], coverageFromRow);
  }
  /**
   * Replace the encounter's coverage set. A coverage keeps its id when the
   * same priority already exists, so claims that reference it stay attached.
   * Priorities absent from the new set are removed unless a claim uses them.
   */
  replaceCoverages(encounterId: EncounterId, coverages: Coverage[]): Coverage[] {
    return this.transaction(() => {
      const existing = new Map(this.listCoverages(encounterId).map((c) => [c.priority, c]));
      const saved: Coverage[] = [];
      for (const c of coverages) {
        const id = existing.get(c.priority)?.id ?? c.id;
        const row = { ...c, id, encounterId };
        this.#run(`insert into coverages (id, encounter_id, priority, payer_id, payer_name, payer_address_json, plan_id, plan_name, group_number, member_id, relationship, subscriber_json, effective_from, effective_to)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          on conflict(id) do update set payer_id=excluded.payer_id, payer_name=excluded.payer_name, payer_address_json=excluded.payer_address_json, plan_id=excluded.plan_id,
            plan_name=excluded.plan_name, group_number=excluded.group_number, member_id=excluded.member_id, relationship=excluded.relationship, subscriber_json=excluded.subscriber_json,
            effective_from=excluded.effective_from, effective_to=excluded.effective_to`,
          [row.id, encounterId, row.priority, row.payerId, row.payerName, json(row.payerAddress), row.planId ?? null, row.planName ?? null, row.groupNumber ?? null,
            row.memberId, row.relationship, json(row.subscriber), row.effectiveFrom ?? null, row.effectiveTo ?? null]);
        saved.push(row);
        existing.delete(c.priority);
      }
      for (const stale of existing.values()) {
        this.#run('delete from coverages where id = ? and not exists (select 1 from claims where coverage_id = ?)', [stale.id, stale.id]);
      }
      return saved;
    });
  }

  // Guarantor

  getGuarantor(encounterId: EncounterId): Guarantor | undefined {
    return this.#one('select * from guarantors where encounter_id = ?', [encounterId], guarantorFromRow);
  }
  saveGuarantor(g: Guarantor): void {
    this.#run(`insert into guarantors (encounter_id, last_name, first_name, middle_name, relationship, address_json, phone) values (?,?,?,?,?,?,?)
      on conflict(encounter_id) do update set last_name=excluded.last_name, first_name=excluded.first_name, middle_name=excluded.middle_name,
        relationship=excluded.relationship, address_json=excluded.address_json, phone=excluded.phone`,
      [g.encounterId, g.lastName, g.firstName, g.middleName ?? null, g.relationship, json(g.address), g.phone ?? null]);
  }

  // Diagnoses

  listDiagnoses(encounterId: EncounterId): Diagnosis[] {
    return this.#many('select * from diagnoses where encounter_id = ? order by sequence', [encounterId], diagnosisFromRow);
  }
  replaceDiagnoses(encounterId: EncounterId, diagnoses: Diagnosis[]): void {
    this.transaction(() => {
      this.#run('delete from diagnoses where encounter_id = ?', [encounterId]);
      for (const d of diagnoses) {
        this.#run('insert into diagnoses (encounter_id, sequence, code, coding_system, description, type, poa) values (?,?,?,?,?,?,?)',
          [encounterId, d.sequence, d.code, d.codingSystem, d.description ?? null, d.type, d.presentOnAdmission ?? null]);
      }
    });
  }

  // Charges

  getCharge(id: ChargeId): Charge | undefined {
    return this.#one('select * from charges where id = ?', [id], chargeFromRow);
  }
  findCharge(encounterId: EncounterId, externalId: string): Charge | undefined {
    return this.#one('select * from charges where encounter_id = ? and external_id = ?', [encounterId, externalId], chargeFromRow);
  }
  listCharges(f: ListChargesFilter = {}): Charge[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (f.encounterId) { where.push('encounter_id = ?'); params.push(f.encounterId); }
    if (f.status) { where.push('status = ?'); params.push(f.status); }
    if (f.claimId) { where.push('claim_id = ?'); params.push(f.claimId); }
    const sql = `select * from charges ${where.length ? 'where ' + where.join(' and ') : ''} order by service_date, external_id`;
    return this.#many(sql, params, chargeFromRow);
  }
  saveCharge(c: Charge): void {
    this.#run(`insert into charges (id, encounter_id, external_id, transaction_type, service_date, posted_date, code_system, code, modifiers_json, description, units, amount,
        department, revenue_code, performing_json, ordering_json, dx_pointers_json, status, claim_id)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set transaction_type=excluded.transaction_type, service_date=excluded.service_date, posted_date=excluded.posted_date,
        code_system=excluded.code_system, code=excluded.code, modifiers_json=excluded.modifiers_json, description=excluded.description, units=excluded.units,
        amount=excluded.amount, department=excluded.department, revenue_code=excluded.revenue_code, performing_json=excluded.performing_json,
        ordering_json=excluded.ordering_json, dx_pointers_json=excluded.dx_pointers_json, status=excluded.status, claim_id=excluded.claim_id`,
      [c.id, c.encounterId, c.externalId, c.transactionType, c.serviceDate, c.postedDate ?? null, c.codeSystem, c.code, JSON.stringify(c.modifiers),
        c.description ?? null, c.units, c.amount, c.department ?? null, c.revenueCode ?? null, json(c.performingProvider), json(c.orderingProvider),
        JSON.stringify(c.diagnosisPointers), c.status, c.claimId ?? null]);
  }

  // Claims

  getClaim(id: ClaimId): Claim | undefined {
    return this.#one('select * from claims where id = ?', [id], claimFromRow);
  }
  findClaimByControlNumber(controlNumber: string): Claim | undefined {
    return this.#one('select * from claims where control_number = ?', [controlNumber], claimFromRow);
  }
  listClaims(f: ListClaimsFilter = {}): Claim[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (f.status) { where.push('status = ?'); params.push(f.status); }
    if (f.encounterId) { where.push('encounter_id = ?'); params.push(f.encounterId); }
    if (f.patientId) { where.push('patient_id = ?'); params.push(f.patientId); }
    const sql = `select * from claims ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc`;
    return this.#many(sql, params, claimFromRow);
  }
  saveClaim(c: Claim): void {
    this.#run(`insert into claims (id, encounter_id, patient_id, coverage_id, type, status, control_number, total_charge, total_paid, total_adjusted, patient_responsibility,
        payer_claim_control_number, submitted_at, created_at, updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set coverage_id=excluded.coverage_id, type=excluded.type, status=excluded.status, total_charge=excluded.total_charge, total_paid=excluded.total_paid,
        total_adjusted=excluded.total_adjusted, patient_responsibility=excluded.patient_responsibility, payer_claim_control_number=excluded.payer_claim_control_number,
        submitted_at=excluded.submitted_at, updated_at=excluded.updated_at`,
      [c.id, c.encounterId, c.patientId, c.coverageId, c.type, c.status, c.controlNumber, c.totalCharge, c.totalPaid, c.totalAdjusted, c.patientResponsibility,
        c.payerClaimControlNumber ?? null, c.submittedAt ?? null, c.createdAt, c.updatedAt]);
  }
  appendClaimEvent(ev: ClaimEvent): void {
    this.#run('insert into claim_events (claim_id, at, from_status, to_status, reason, detail_json) values (?,?,?,?,?,?)',
      [ev.claimId, ev.at, ev.from, ev.to, ev.reason, json(ev.detail)]);
  }
  listClaimEvents(claimId: ClaimId): ClaimEvent[] {
    return this.#many('select * from claim_events where claim_id = ? order by seq', [claimId], claimEventFromRow);
  }
  savePayment(p: Payment): void {
    this.#run('insert into payments (claim_id, at, source, remittance_json) values (?,?,?,?)', [p.claimId, p.at, p.source, JSON.stringify(p.remittance)]);
  }
  listPayments(claimId: ClaimId): Payment[] {
    return this.#many('select * from payments where claim_id = ? order by seq', [claimId], paymentFromRow);
  }
  /** Open receivables grouped by status: count and outstanding balance (charge − paid − adjusted). */
  claimTotalsByStatus(): { status: ClaimStatus; count: number; outstanding: number }[] {
    return this.#db.prepare(
      'select status, count(*) as count, sum(total_charge - total_paid - total_adjusted) as outstanding from claims group by status order by status',
    ).all() as { status: ClaimStatus; count: number; outstanding: number }[];
  }

  // Inbound messages

  findMessage(sendingFacility: string, controlId: string): InboundMessage | undefined {
    return this.#one('select * from inbound_messages where sending_facility = ? and control_id = ?', [sendingFacility, controlId], messageFromRow);
  }
  getMessage(id: MessageId): InboundMessage | undefined {
    return this.#one('select * from inbound_messages where id = ?', [id], messageFromRow);
  }
  listMessages(status?: InboundMessageStatus, limit = 100): InboundMessage[] {
    return status
      ? this.#many('select * from inbound_messages where status = ? order by received_at desc limit ?', [status, limit], messageFromRow)
      : this.#many('select * from inbound_messages order by received_at desc limit ?', [limit], messageFromRow);
  }
  saveMessage(m: InboundMessage): void {
    this.#run(`insert into inbound_messages (id, control_id, sending_application, sending_facility, message_type, trigger_event, received_at, raw, status, error)
      values (?,?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set received_at=excluded.received_at, raw=excluded.raw, status=excluded.status, error=excluded.error`,
      [m.id, m.controlId, m.sendingApplication, m.sendingFacility, m.messageType, m.triggerEvent, m.receivedAt, m.raw, m.status, m.error ?? null]);
  }
}
