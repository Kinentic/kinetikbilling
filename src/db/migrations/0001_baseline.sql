create table if not exists patients (
  id text primary key,
  mrn_value text not null,
  mrn_authority text not null,
  mrn_type text not null,
  last_name text not null,
  first_name text not null,
  middle_name text,
  dob text,
  sex text not null,
  address_json text,
  phone text,
  ssn_last4 text,
  merged_into text references patients(id),
  updated_at text not null,
  unique (mrn_value, mrn_authority)
);

create table if not exists encounters (
  id text primary key,
  patient_id text not null references patients(id),
  account_number text not null,
  facility text not null,
  visit_number text,
  patient_class text not null,
  admit_at text,
  discharge_at text,
  location text,
  attending_json text,
  referring_json text,
  financial_class text,
  hospital_service text,
  updated_at text not null,
  unique (facility, account_number)
);
create index if not exists encounters_patient on encounters(patient_id);

create table if not exists coverages (
  id text primary key,
  encounter_id text not null references encounters(id) on delete cascade,
  priority integer not null,
  payer_id text not null,
  payer_name text not null,
  payer_address_json text,
  plan_id text,
  plan_name text,
  group_number text,
  member_id text not null,
  relationship text not null,
  subscriber_json text not null,
  effective_from text,
  effective_to text,
  unique (encounter_id, priority)
);

create table if not exists guarantors (
  encounter_id text primary key references encounters(id) on delete cascade,
  last_name text not null,
  first_name text not null,
  middle_name text,
  relationship text not null,
  address_json text,
  phone text
);

create table if not exists diagnoses (
  encounter_id text not null references encounters(id) on delete cascade,
  sequence integer not null,
  code text not null,
  coding_system text not null,
  description text,
  type text not null,
  poa text,
  primary key (encounter_id, sequence)
);

create table if not exists charges (
  id text primary key,
  encounter_id text not null references encounters(id),
  external_id text not null,
  transaction_type text not null,
  service_date text not null,
  posted_date text,
  code_system text not null,
  code text not null,
  modifiers_json text not null,
  description text,
  units real not null,
  amount integer not null,
  department text,
  revenue_code text,
  performing_json text,
  ordering_json text,
  dx_pointers_json text not null,
  status text not null,
  claim_id text references claims(id),
  unique (encounter_id, external_id)
);
create index if not exists charges_claim on charges(claim_id);

create table if not exists claims (
  id text primary key,
  encounter_id text not null references encounters(id),
  patient_id text not null references patients(id),
  coverage_id text not null references coverages(id),
  type text not null,
  status text not null,
  control_number text not null unique,
  total_charge integer not null,
  total_paid integer not null,
  total_adjusted integer not null,
  patient_responsibility integer not null,
  payer_claim_control_number text,
  submitted_at text,
  created_at text not null,
  updated_at text not null
);
create index if not exists claims_status on claims(status);
create index if not exists claims_encounter on claims(encounter_id);

create table if not exists claim_events (
  seq integer primary key autoincrement,
  claim_id text not null references claims(id),
  at text not null,
  from_status text,
  to_status text not null,
  reason text not null,
  detail_json text
);
create index if not exists claim_events_claim on claim_events(claim_id);

create table if not exists payments (
  seq integer primary key autoincrement,
  claim_id text not null references claims(id),
  at text not null,
  source text not null,
  remittance_json text not null
);

create table if not exists inbound_messages (
  id text primary key,
  control_id text not null,
  sending_application text not null,
  sending_facility text not null,
  message_type text not null,
  trigger_event text not null,
  received_at text not null,
  raw text not null,
  status text not null,
  error text,
  unique (sending_facility, control_id)
);
create index if not exists inbound_messages_received on inbound_messages(received_at);
