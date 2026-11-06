-- M1: documents, coding tasks, code log, provider queries, fee schedule, the ClaimCharge link
-- table, and charges rebuilt with a source and by-value diagnoses.
-- Runs inside migrate()'s transaction with foreign_keys off; foreign_key_check runs before commit.

-- Documents: insert-only versions. Writer: ingest/upsert.ts appendDocumentVersion.
create table documents (
  id text primary key,
  encounter_id text not null references encounters(id),
  message_id text not null,            -- inbound_messages.id; no FK: the audit row is written after the handler
  external_id text not null,
  version integer not null check (version >= 1),
  kind text not null check (kind in ('progress_note', 'radiology_report', 'other')),
  status text not null check (status in ('preliminary', 'final', 'corrected')),
  title text,
  author_json text,
  signed_at text,
  observed_at text,
  body text not null,
  attachment_json text,
  recorded_at text not null,
  unique (encounter_id, external_id, version)
);
create trigger documents_immutable before update on documents
  begin select raise(abort, 'documents are immutable; append a new version'); end;
create trigger documents_no_delete before delete on documents
  begin select raise(abort, 'documents are immutable'); end;

-- Coding tasks: one per encounter, ever. Status is written only through recordTaskTransition.
create table coding_tasks (
  id text primary key,
  encounter_id text not null unique references encounters(id),
  status text not null check (status in ('awaiting_documentation', 'ready_to_code', 'in_progress', 'on_hold_query', 'coded', 'qa_review', 'returned_to_coder', 'released')),
  specialty text check (specialty is null or specialty in ('primary_care', 'radiology')),
  assignee text,
  origin_json text not null,
  documentation_due_at text,
  created_at text not null,
  updated_at text not null
);
create index coding_tasks_status on coding_tasks(status, documentation_due_at);

create table coding_task_events (
  seq integer primary key autoincrement,
  task_id text not null references coding_tasks(id),
  at text not null,
  from_status text,
  to_status text not null,
  reason text not null,
  actor text,
  detail_json text
);
create index coding_task_events_task on coding_task_events(task_id, seq);

-- Provider queries. Writer: coding/queries.ts.
create table provider_queries (
  id text primary key,
  task_id text not null references coding_tasks(id),
  question text not null,
  raised_by text not null,
  sent_to_json text,
  channel text not null check (channel in ('in_app', 'email', 'cerner_message', 'verbal')),
  sent_at text not null,
  answer_text text,
  answered_at text,
  check ((answer_text is null) = (answered_at is null))
);
create index provider_queries_task on provider_queries(task_id);

-- Code log: append-only, one row per decision. Writer: coding/codes.ts.
create table code_assignments (
  seq integer primary key autoincrement,         -- log order
  id text not null unique,
  encounter_id text not null references encounters(id),
  line_id text not null,
  supersedes text unique references code_assignments(id),  -- a row is superseded at most once: no forks
  kind text not null check (kind in ('procedure', 'diagnosis')),
  content_json text not null,
  removed integer not null check (removed in (0, 1)),
  provenance text not null check (provenance in ('cerner_dft', 'coder', 'ai_suggestion', 'provider_query')),
  source_ref text,
  suggested_by_json text,
  decided_by text,
  decided_at text,
  query_id text references provider_queries(id),
  recorded_at text not null,
  check ((decided_by is null) = (decided_at is null)),
  check (source_ref is null or provenance = 'cerner_dft')
);
create index code_assignments_encounter on code_assignments(encounter_id, seq);
create index code_assignments_source_ref on code_assignments(encounter_id, source_ref);
create trigger code_assignments_no_update before update on code_assignments
  begin select raise(abort, 'code_assignments is append-only'); end;
create trigger code_assignments_no_delete before delete on code_assignments
  begin select raise(abort, 'code_assignments is append-only'); end;

-- Fee schedule. Writer: coding/fees.ts replaceFeeSchedule (whole-set replacement).
create table fee_schedule_lines (
  code text not null,
  modifiers_key text not null,          -- sorted modifiers joined with ':'; '' is the base price
  amount integer not null check (amount >= 0),
  effective_from text not null,
  effective_to text,
  primary key (code, modifiers_key, effective_from)
);

-- ClaimCharge replaces charges.claim_id. Insert-only; written only by claims/build.ts.
create table claim_charges (
  claim_id text not null references claims(id),
  charge_id text not null references charges(id),
  attached_at text not null,
  primary key (claim_id, charge_id)
);
create index claim_charges_charge on claim_charges(charge_id);

insert into claim_charges (claim_id, charge_id, attached_at)
  select ch.claim_id, ch.id, cl.created_at from charges ch join claims cl on cl.id = ch.claim_id
  where ch.claim_id is not null;

-- Rebuild charges: drop claim_id and status, add source, code_assignment_id, voided_at;
-- dx_pointers_json becomes diagnoses_json (ChargeDiagnosis[] by value). Each pointer joins the
-- encounter's diagnoses row with that sequence, in pointer order; a dangling pointer is dropped.
create table charges_new (
  id text primary key,
  encounter_id text not null references encounters(id),
  source text not null check (source in ('cerner_dft', 'coder')),
  external_id text not null,
  code_assignment_id text references code_assignments(id),
  voided_at text,
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
  diagnoses_json text not null,
  unique (encounter_id, source, external_id),
  check ((source = 'coder') = (code_assignment_id is not null)),
  check (voided_at is null or source = 'coder')
);
insert into charges_new (id, encounter_id, source, external_id, code_assignment_id, voided_at, transaction_type, service_date,
    posted_date, code_system, code, modifiers_json, description, units, amount, department, revenue_code, performing_json,
    ordering_json, diagnoses_json)
  select c.id, c.encounter_id, 'cerner_dft', c.external_id, null, null,
    c.transaction_type, c.service_date, c.posted_date, c.code_system, c.code, c.modifiers_json, c.description, c.units, c.amount,
    c.department, c.revenue_code, c.performing_json, c.ordering_json,
    coalesce((select json_group_array(json(case when d.description is null
                  then json_object('sequence', d.sequence, 'code', d.code, 'codingSystem', d.coding_system)
                  else json_object('sequence', d.sequence, 'code', d.code, 'codingSystem', d.coding_system, 'description', d.description) end) order by p.key)
              from json_each(c.dx_pointers_json) p join diagnoses d on d.encounter_id = c.encounter_id and d.sequence = p.value), '[]')
  from charges c;
drop table charges;
alter table charges_new rename to charges;
create index charges_encounter on charges(encounter_id, source);

-- Coder charges: only voided_at may change, and only from null.
create trigger coder_charges_immutable before update on charges when old.source = 'coder'
  and (old.voided_at is not null or new.amount is not old.amount or new.code is not old.code
       or new.modifiers_json is not old.modifiers_json or new.units is not old.units
       or new.diagnoses_json is not old.diagnoses_json or new.performing_json is not old.performing_json)
  begin select raise(abort, 'coder charges are immutable except voided_at'); end;

-- Derived charge status: the only definition of unbilled / claimed / voided.
create view charge_states as
  select c.*,
    case when c.voided_at is not null then 'voided'
         when exists (select 1 from claim_charges cc where cc.charge_id = c.id) then 'claimed'
         else 'unbilled' end as status,
    (select json_group_array(cc.claim_id) from claim_charges cc where cc.charge_id = c.id) as claim_ids_json
  from charges c;
