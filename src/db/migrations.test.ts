import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadMigrations, migrate } from './migrations.ts';
import { Store } from './store.ts';
import type { ChargeId, ClaimId } from '../domain/types.ts';

/** The v0.1 schema as the Store applied it on every open, before migrations existed. */
const V01_SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;
create table if not exists patients (
  id text primary key, mrn_value text not null, mrn_authority text not null, mrn_type text not null, last_name text not null, first_name text not null,
  middle_name text, dob text, sex text not null, address_json text, phone text, ssn_last4 text, merged_into text references patients(id),
  updated_at text not null, unique (mrn_value, mrn_authority)
);
create table if not exists encounters (
  id text primary key, patient_id text not null references patients(id), account_number text not null, facility text not null, visit_number text,
  patient_class text not null, admit_at text, discharge_at text, location text, attending_json text, referring_json text, financial_class text,
  hospital_service text, updated_at text not null, unique (facility, account_number)
);
create index if not exists encounters_patient on encounters(patient_id);
create table if not exists coverages (
  id text primary key, encounter_id text not null references encounters(id) on delete cascade, priority integer not null, payer_id text not null,
  payer_name text not null, payer_address_json text, plan_id text, plan_name text, group_number text, member_id text not null, relationship text not null,
  subscriber_json text not null, effective_from text, effective_to text, unique (encounter_id, priority)
);
create table if not exists guarantors (
  encounter_id text primary key references encounters(id) on delete cascade, last_name text not null, first_name text not null, middle_name text,
  relationship text not null, address_json text, phone text
);
create table if not exists diagnoses (
  encounter_id text not null references encounters(id) on delete cascade, sequence integer not null, code text not null, coding_system text not null,
  description text, type text not null, poa text, primary key (encounter_id, sequence)
);
create table if not exists charges (
  id text primary key, encounter_id text not null references encounters(id), external_id text not null, transaction_type text not null,
  service_date text not null, posted_date text, code_system text not null, code text not null, modifiers_json text not null, description text,
  units real not null, amount integer not null, department text, revenue_code text, performing_json text, ordering_json text,
  dx_pointers_json text not null, status text not null, claim_id text references claims(id), unique (encounter_id, external_id)
);
create index if not exists charges_claim on charges(claim_id);
create table if not exists claims (
  id text primary key, encounter_id text not null references encounters(id), patient_id text not null references patients(id),
  coverage_id text not null references coverages(id), type text not null, status text not null, control_number text not null unique,
  total_charge integer not null, total_paid integer not null, total_adjusted integer not null, patient_responsibility integer not null,
  payer_claim_control_number text, submitted_at text, created_at text not null, updated_at text not null
);
create index if not exists claims_status on claims(status);
create index if not exists claims_encounter on claims(encounter_id);
create table if not exists claim_events (
  seq integer primary key autoincrement, claim_id text not null references claims(id), at text not null, from_status text, to_status text not null,
  reason text not null, detail_json text
);
create index if not exists claim_events_claim on claim_events(claim_id);
create table if not exists payments (
  seq integer primary key autoincrement, claim_id text not null references claims(id), at text not null, source text not null, remittance_json text not null
);
create table if not exists inbound_messages (
  id text primary key, control_id text not null, sending_application text not null, sending_facility text not null, message_type text not null,
  trigger_event text not null, received_at text not null, raw text not null, status text not null, error text, unique (sending_facility, control_id)
);
create index if not exists inbound_messages_received on inbound_messages(received_at);
`;

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'kinetik-migrations-'));

/** A v0.1 database with one claimed charge whose pointers index the encounter's two diagnoses in reverse order. */
const v01Database = (path: string): { chargeId: ChargeId; claimId: ClaimId } => {
  const db = new DatabaseSync(path);
  db.exec(V01_SCHEMA);
  const now = '2026-10-01T00:00:00.000Z';
  db.exec(`
    insert into patients (id, mrn_value, mrn_authority, mrn_type, last_name, first_name, sex, updated_at) values ('P1', '100', 'CERNER', 'MR', 'Doe', 'Jane', 'F', '${now}');
    insert into encounters (id, patient_id, account_number, facility, patient_class, updated_at) values ('E1', 'P1', 'FIN1', 'HOSP', 'O', '${now}');
    insert into coverages (id, encounter_id, priority, payer_id, payer_name, member_id, relationship, subscriber_json)
      values ('V1', 'E1', 1, '60054', 'Aetna', 'M1', 'self', '{"lastName":"Doe","firstName":"Jane"}');
    insert into diagnoses (encounter_id, sequence, code, coding_system, description, type) values ('E1', 1, 'E11.9', 'ICD10', 'Type 2 diabetes', 'F');
    insert into diagnoses (encounter_id, sequence, code, coding_system, description, type) values ('E1', 2, 'I10', 'ICD10', null, 'F');
    insert into claims (id, encounter_id, patient_id, coverage_id, type, status, control_number, total_charge, total_paid, total_adjusted, patient_responsibility, created_at, updated_at)
      values ('K1', 'E1', 'P1', 'V1', 'professional', 'ready', 'FIN1-1', 12550, 0, 0, 0, '${now}', '${now}');
    insert into charges (id, encounter_id, external_id, transaction_type, service_date, code_system, code, modifiers_json, units, amount, dx_pointers_json, status, claim_id)
      values ('C1', 'E1', 'T1', 'CG', '2026-10-01', 'CPT', '99213', '["25"]', 1, 12550, '[2,1]', 'claimed', 'K1');
    insert into charges (id, encounter_id, external_id, transaction_type, service_date, code_system, code, modifiers_json, units, amount, dx_pointers_json, status)
      values ('C2', 'E1', 'T2', 'CG', '2026-10-01', 'CPT', '36415', '[]', 1, 1500, '[1,9]', 'unbilled');
  `);
  db.close();
  return { chargeId: 'C1' as ChargeId, claimId: 'K1' as ClaimId };
};

const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

test('a v0.1 database migrates to version 2: links backfilled, pointers converted to diagnoses by value in pointer order', () => {
  const path = join(tempDir(), 'billing.db');
  const { chargeId, claimId } = v01Database(path);

  const store = new Store(path);
  const claimed = store.getCharge(chargeId)!;
  assert.equal(claimed.source, 'cerner_dft');
  assert.equal(claimed.status, 'claimed');
  assert.deepEqual(claimed.claimIds, [claimId]);
  assert.deepEqual(claimed.diagnoses, [
    { sequence: 2, code: 'I10', codingSystem: 'ICD10' },
    { sequence: 1, code: 'E11.9', codingSystem: 'ICD10', description: 'Type 2 diabetes' },
  ]);
  assert.deepEqual(claimed.modifiers, ['25']);
  assert.deepEqual(store.listCharges({ claimId }).map((c) => c.id), [chargeId]);

  const unbilled = store.listCharges({ status: 'unbilled' });
  assert.deepEqual(unbilled.map((c) => [c.externalId, c.claimIds, c.diagnoses.map((d) => d.code)]), [['T2', [], ['E11.9']]], 'a dangling pointer is dropped');
  store.close();

  const db = new DatabaseSync(path);
  assert.equal((db.prepare('pragma user_version').get() as { user_version: number }).user_version, 2);
  const charges = columns(db, 'charges');
  assert.ok(!charges.includes('claim_id') && !charges.includes('status') && !charges.includes('dx_pointers_json'), charges.join(','));
  assert.deepEqual(db.prepare('select claim_id, charge_id from claim_charges').all().map((r) => ({ ...r })), [{ claim_id: claimId, charge_id: chargeId }]);
  assert.deepEqual(migrate(db, loadMigrations()), { from: 2, to: 2 }, 'a second open has nothing to apply');
  db.close();
});

const COMMON_TABLES = ['documents', 'coding_tasks', 'coding_task_events', 'provider_queries', 'code_assignments', 'fee_schedule_lines', 'claim_charges'];

test('version 2 creates the coding tables, and their append-only triggers abort updates and deletes', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, loadMigrations());
  const tables = (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of COMMON_TABLES) assert.ok(tables.includes(t), t);
  assert.deepEqual(db.prepare("pragma foreign_key_list(charges)").all().map((r) => (r as { table: string }).table).sort(), ['code_assignments', 'encounters']);
  db.exec(`
    insert into patients (id, mrn_value, mrn_authority, mrn_type, last_name, first_name, sex, updated_at) values ('P1', '1', 'C', 'MR', 'D', 'J', 'F', 't');
    insert into encounters (id, patient_id, account_number, facility, patient_class, updated_at) values ('E1', 'P1', 'F', 'H', 'O', 't');
    insert into documents (id, encounter_id, message_id, external_id, version, kind, status, body, recorded_at) values ('D1', 'E1', 'M1', 'DOC1', 1, 'progress_note', 'final', 'x', 't');
    insert into code_assignments (id, encounter_id, line_id, kind, content_json, removed, provenance, recorded_at) values ('A1', 'E1', 'L1', 'diagnosis', '{}', 0, 'coder', 't');
  `);
  assert.throws(() => db.exec("update documents set body = 'y' where id = 'D1'"), /immutable/);
  assert.throws(() => db.exec("delete from documents where id = 'D1'"), /immutable/);
  assert.throws(() => db.exec("update code_assignments set removed = 1 where id = 'A1'"), /append-only/);
  assert.throws(() => db.exec("delete from code_assignments where id = 'A1'"), /append-only/);
  assert.equal((db.prepare('select count(*) as n from documents').get() as { n: number }).n, 1);
  db.close();
});

test('a fresh database and a migrated v0.1 database have the same charges shape', () => {
  const dir = tempDir();
  const fresh = new Store(join(dir, 'fresh.db'));
  fresh.close();
  v01Database(join(dir, 'old.db'));
  new Store(join(dir, 'old.db')).close();
  const a = new DatabaseSync(join(dir, 'fresh.db'));
  const b = new DatabaseSync(join(dir, 'old.db'));
  for (const t of ['charges', ...COMMON_TABLES]) assert.deepEqual(columns(a, t), columns(b, t), t);
  a.close();
  b.close();
});

test('a gap or a misnamed file in the migrations directory is refused before anything runs', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '0001_a.sql'), 'create table a (x);');
  writeFileSync(join(dir, '0003_c.sql'), 'create table c (x);');
  assert.throws(() => loadMigrations(pathToFileURL(dir + '/')), /1\.\.n without gaps/);
  writeFileSync(join(dir, '0002_b.sql'), 'create table b (x);');
  assert.deepEqual(loadMigrations(pathToFileURL(dir + '/')).map((m) => [m.version, m.name]), [[1, 'a'], [2, 'b'], [3, 'c']]);
  writeFileSync(join(dir, 'notes.sql'), '-- not a migration');
  assert.throws(() => loadMigrations(pathToFileURL(dir + '/')), /NNNN_name\.sql/);
});

test('a migration that fails rolls back alone and leaves user_version where it was', () => {
  const db = new DatabaseSync(':memory:');
  const good = { version: 1, name: 'good', sql: 'create table t (x);' };
  const bad = { version: 2, name: 'bad', sql: 'insert into t values (1); create table t (y);' };
  assert.throws(() => migrate(db, [good, bad]), /already exists/);
  assert.equal((db.prepare('pragma user_version').get() as { user_version: number }).user_version, 1);
  assert.equal((db.prepare('select count(*) as n from t').get() as { n: number }).n, 0);
  assert.equal((db.prepare('pragma foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
});
