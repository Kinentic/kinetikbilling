# Kinetik Billing: Developer Specification

**Repository:** `github.com/Kinentic/kinetikbilling`, reviewed at commit `ee92c53` ("Document the service: run, pipeline,
lifecycle, API, layout, known gaps"), 2026-11-05.
**Author:** drafted for Ken Kubota (KinetikData LLC) with Claude, 2026-11-05. Status: **draft for review** by Ken and
Harpreet Singh before any engineering starts against it.
**Audience:** the engineers (human or AI-assisted) who will take the current service to a system that bills a real
client, and the coding team that will work in it.

> **What this document is not.** It does not restate HL7 or billing basics; see the plain-language primer and the
> cheat sheet in `MLKCH/Meetings/` for those. It does not fix the go-to-market decision (licensed PM first versus
> this system first); section 3 states the decision this spec assumes and the fallback if milestones slip.
> Statements about Cerner's live interface behaviour, clearinghouse specifics and Medi-Cal billing rules are
> marked **verify** and must be confirmed with MLKCH IT, the chosen clearinghouse, or Harpreet before they become
> acceptance criteria.

---

## 1. Purpose and scope

Kinetik Billing is KinetikData's own billing system (the "practice-management" layer MLKCH does not have). It
receives HL7 v2 feeds from a hospital's Cerner Millennium, gives a coding team the documentation it needs to code
each encounter, builds professional claims, submits them to a clearinghouse, posts remittances, and works denials
and receivables. The first client scenario is MLK Community Healthcare (MLKCH): a family-care clinic and a radiology
unit, Medi-Cal heavy, coded and billed by Harpreet Singh's team in India, with KinetikData as the contracting
entity.

**In scope for the versions this spec covers (v0.2 through v1.0):** document ingest (notes and reports), a coding
workbench, multi-client tenancy, authentication and audit, clearinghouse transport and acknowledgement parsing, fee
schedule and payer rules for Medi-Cal, denial and AR work, reporting, and the hosting and security posture to hold
PHI in production. An AI coding-assistance slot is designed in but implemented last.

**Out of scope until after v1.0:** institutional (837I) facility billing, patient statements and payment plans,
secondary and crossover billing beyond the data model change that enables it, a patient portal, and autonomous
(unreviewed) coding of any kind.

## 2. Current state of the repository (verified by reading; tests not executed here)

Node 24 and TypeScript, run directly with no runtime dependencies; SQLite through `node:sqlite`. About 4,800 lines
including tests and fixtures. The README's claims were checked against the source; the test suite and `npm run e2e`
were **not run** in this review (the review environment refused to execute the external code), so "tests exist" is
verified and "tests pass" is not.

| Area | What exists | Files |
|---|---|---|
| HL7 transport and parsing | MLLP server with 16 MiB frame cap, one connection at a time; parser for segments, fields, repetitions, components, escapes; ACK builder; HL7 date handling | `src/hl7/mllp.ts`, `parse.ts`, `ack.ts`, `datetime.ts` |
| Ingest | Audit row per message keyed on (MSH-4, MSH-10); duplicates acknowledged and skipped; unsupported types acknowledged and stored; handler registry; segment mappers for PID, PV1, IN1, GT1, DG1, FT1 and the composite types; upserts | `src/ingest/process.ts`, `registry.ts`, `upsert.ts`, `map/*`, `handlers/*` |
| Message types handled | ADT A01, A04, A08, A28, A31, A03 (discharge), A40 (merge); BAR P01, P05; DFT P03 (charges keyed on FT1-2, CG positive, CD negative) | `src/ingest/registry.ts` |
| Domain model | Branded ids, integer cents, Patient, Encounter, Coverage (priority 1 to 3), Guarantor, Diagnosis, Charge (status unbilled, claimed, voided; one `claimId`), Claim with a closed `ClaimStatus` union, ClaimEvent, Remittance, Payment, InboundMessage | `src/domain/types.ts` |
| Store | SQLite schema (WAL, foreign keys) and a `Store` class that is the only code knowing column names; transactions | `src/db/schema.sql`, `store.ts` |
| Claims engine | One claim per encounter and coverage from unbilled charges; scrubber as a rule table (18 rules: presence, ICD-10 shape, NPI Luhn, pointers, modifiers, duplicates, service dates); state machine with a transition table and event log; 837P writer (005010X222A1 loops 1000A/B, 2000A, 2010AA, 2000B, 2010BA/BB, 2000C/2010CA, 2300 CLM and HI, 2310B rendering, 2400 SV1/DTP/REF); 835 parser (BPR, TRN, CLP, CAS) and posting | `src/claims/*` |
| API | Unauthenticated REST over `node:http`: HL7 by POST, message audit and replay, patients, encounters, charges, claim build/scrub/submit/acknowledge/rework/close, 837P render, 835 post, AR summary | `src/api/routes.ts`, `router.ts` |
| Fixtures and scripts | Seven hand-built HL7 2.5.1 messages with fake PHI; MLLP send script; end-to-end script from feed to posted payment | `fixtures/hl7/*`, `scripts/*` |

**Gaps the README itself names:** secondary billing (one `claimId` per charge), 837I, 999 and 277CA parsing, patient
statements, fee schedule (amounts come from FT1-11), persisted X12 control numbers, transport security (plaintext
MLLP, no API auth, unencrypted SQLite). Fixtures have not met a live Cerner interface and the 837P has not been
through a clearinghouse validator.

**Gaps this spec adds, from the MLKCH scenario:** no document feeds (MDM, ORU) or scheduling (SIU); no coding
workflow at all (charges arrive pre-coded from Cerner, which is the opposite of the coder-centred model); single
tenant; no users, roles or PHI access audit; no payer or provider directories; no clearinghouse transport; no denial
or AR worklists; no reporting beyond an AR summary; no UI.

**Architectural qualities worth keeping:** wire formats parsed into domain types at the boundary and never leaking
past it; the closed status union with a single `transition` function; the audit-everything ingest; integer cents;
the no-dependency stance; small files with tests beside them. New work should preserve these.

## 3. Decision this spec assumes, and the fallback

**Assumed:** Kinetik Billing is being built to be the production billing system for MLKCH, with Harpreet's coders
working in it from go-live. The milestones in section 12 are sized to that.

**Fallback, stated now so nobody is surprised later:** MLKCH wants a decision by mid-December 2026 and a start in
early 2027. If milestones M1 to M5 are not demonstrably complete by the date the proposal is presented (target late
November 2026), the proposal commits to a licensed billing-company PM for claim submission and remittance, and
Kinetik Billing enters as the coding workbench and data layer first (feeds in, coders code, finished codes pushed
to the PM), taking over claim submission later. The architecture below supports both paths without rework: the
coding workbench writes charges with `source = 'coder'`; whether those charges become an 837P in this system or are
exported to a PM is a configuration of the submission module.

Two companion documents from 2026-11-04 bear on this decision and are not repeated here: the billing-platform options
memo (Options 0 to 4 and the eight knockout criteria) and the OpenEMR assessment, which concluded that OpenEMR bills
well but has no HL7 listener or charge API and therefore fails the first knockout criterion as a day-one platform.
That finding is one reason this spec treats Kinetik Billing's own ingest, which already exists, as the asset to build
on rather than adopting an open-source PM as the base.

## 4. Target architecture

```
                 Cerner Millennium (hosted by Oracle Health)         Clearinghouse (TBD: Availity / Office Ally / Waystar)
                 ADT  SIU  DFT  MDM  ORU  (MLLP over VPN)              837P out, 999 / 277CA / 835 in (SFTP or API)
                        |                                                       ^           |
   =====================|=== Azure, US region, under BAA ========================|===========|=======================
                        v                                                       |           v
   +--------------+   +-----------+   +-------------------+   +--------------+  |   +-----------------+
   | MLLP listener|-->| Ingest    |-->| Store (Postgres)  |<--| Claims engine|--+   | Remittance and  |
   | (+ TLS/VPN)  |   | audit,    |   | patients, encs,   |   | build, scrub,|      | acknowledgement |
   +--------------+   | dispatch, |   | coverage, docs,   |   | 837P, submit |      | parsing, posting|
                      | map       |   | coding tasks,     |   +--------------+      +-----------------+
                      +-----------+   | charges, claims,  |          ^
                                      | payments, audit   |          |
                                      +-------------------+          |
                                               ^                     |
                                               |                     |
                      +------------------------+---------------------+------------------+
                      |                        |                                        |
               +-------------+        +----------------+                      +-----------------+
               | Coding      |        | Denials and AR |                      | Reporting and   |
               | workbench   |        | worklists      |                      | dashboard feeds |
               | (API + UI)  |        +----------------+                      +-----------------+
               +-------------+
                      ^
                      |  HTTPS, OIDC (Entra ID), RBAC, per-tenant isolation, PHI access audit
               Coders (India), coding leads, billers, KinetikData admins, client read-only viewers
```

Principles: one process may still serve everything at MLKCH's volume, but the modules keep their boundaries so they
can be split later; every PHI read and write is attributable to a user or a feed; no PHI leaves the Azure tenant
(coders view, they do not download); every inbound and outbound wire message is archived verbatim.

## 5. Domain model changes

Additions to `src/domain/types.ts` and `src/db/schema.sql`. Names are proposals; keep the branded-id and
integer-cents conventions.

### 5.1 Tenancy and directories
- **Tenant** (client): id, name, status. Every table that holds client data gains `tenant_id`; the `Store` scopes
  every query by it. The MLLP listener maps `(sending_facility, sending_application)` to a tenant; an unmapped
  sender is acknowledged, stored, and alerted on, never processed.
- **Facility**: per tenant; Cerner facility code, name, place-of-service code, address, NPI if it bills as a
  location.
- **ProviderDirectory**: NPI, name, taxonomy, credentials, tenant, role flags (rendering, billing, referring,
  supervising), active dates. Replaces the single `BillingProviderConfig` from the environment with per-tenant
  billing-provider records; the environment keeps only the submitter identity.
- **Payer**: payer name, clearinghouse payer id (per clearinghouse), Medi-Cal flag, managed-care plan flag, IPA
  flag, timely-filing days, enrollment status for claims (837) and for electronic remittance (835), effective
  dates. **PayerAlias** maps the IN1-3/IN1-4 values Cerner sends to a Payer.
- **FeeSchedule** and **FeeScheduleLine**: per tenant, per code and modifier set, charge amount in cents, effective
  dates. **ContractRate** (optional in v1): expected allowable per payer per code, for underpayment detection.

### 5.2 Documents and scheduling
- **Document**: tenant, encounter, source message id, type (progress note, radiology report, other), author
  provider, status (preliminary, final, corrected), signed-at, title, body text, optional attachment (base64 PDF or
  RTF decoded to text where possible), external document id (TXA-12 or OBR-3), version. Documents are immutable
  rows; a correction creates a new version and marks the prior one superseded.
- **Appointment**: tenant, patient, encounter (when linkable), scheduled start and end, provider, location, status
  (booked, rescheduled, cancelled, no-show, arrived), external id (SCH-1). Drives pre-visit eligibility work.

### 5.3 Coding
- **CodingTask**: tenant, encounter, status (see 7.1), priority, assigned coder, due-at, created-from (document id
  or DFT), specialty (primary care, radiology), hold reason, released-at, QA sample flag.
- **CodeAssignment**: tenant, encounter, task, kind (procedure, diagnosis, modifier), code system, code, modifiers,
  units, service date, rendering provider, diagnosis pointers, provenance (`cerner_dft` | `coder` | `ai_suggestion`
  | `provider_query`), suggested-by (AI model and version when applicable), decided-by (user), decided-at,
  superseded-by. Every change is a new row; nothing is updated in place. **Charge** gains `source` (`cerner_dft` |
  `coder`) and `codeAssignmentId`; coder-sourced charges take their amount from the fee schedule, not FT1-11.
- **ProviderQuery**: task, question text, sent-to provider, sent-at, channel (in-app, email to the client's query
  mailbox, Cerner message when available, verify), answered-at, answer text, outcome.
- **CodingAudit** (QA): task, reviewer, sample reason, findings per code (agree, change, add, remove), accuracy
  outcome. Feeds the accuracy metric.
- **AiSuggestion**: task, document(s) read, model and version, proposed codes with supporting text spans and
  confidence, created-at. Coder decisions are recorded on CodeAssignment, so acceptance rate is a join, not a field.

### 5.4 Claims, acknowledgements, denials
- **ClaimCharge** link table replaces `charges.claim_id` so a charge can sit on a primary and later a secondary
  claim. `Charge.status` becomes derived (unbilled if no open or paid claim link).
- **ClaimBatch**: the X12 interchange actually sent: tenant, clearinghouse, ISA13 and GS06 from a **persisted
  sequence**, file name, sent-at, transport result, raw file (archived verbatim), 999 status, 277CA summary.
- **Acknowledgement**: batch or claim, type (999, 277CA, clearinghouse report), raw, parsed status, codes, received-at.
- **DenialWorkItem**: claim line or claim, CARC and RARC codes, denial category (eligibility, authorization, coding,
  timely filing, duplicate, other), owner, status (new, working, appealed, resolved, written off), timely-filing
  deadline (computed from Payer), notes, appeal packet reference.
- **Claim** gains `payerId`, `batchId`, `type` already present; status union gains `appealed` (from denied) and
  `written_off` (terminal, with reason). Update `TRANSITIONS` and the README diagram together.

### 5.5 Users and audit
- **User**: id, tenant scope (one tenant, or KinetikData-wide), roles, OIDC subject, status, location policy tag.
- **AccessLog**: user or feed, action, entity type and id, tenant, at, request id, client IP country. Written for
  every PHI read through the API, not only writes. Append-only table, exported nightly to immutable storage.

## 6. HL7 ingest extensions

Keep the existing pattern: one mapper file per segment family under `src/ingest/map/`, one handler per message
family under `src/ingest/handlers/`, registered in `registry.ts`. Every new handler ships with a fixture under
`fixtures/hl7/` built to HL7 2.5.1 positions and a process test in `process.test.ts`.

| Message | Handler behaviour | Notes |
|---|---|---|
| **MDM^T02** (and T04, T08, T10 as corrections, verify which Cerner sends) | Upsert demographics from PID/PV1; create a Document from TXA (type, author, status, timestamps, document id) and the OBX segments (text; OBX-2 FT/TX concatenated, ED decoded); create or update the encounter's CodingTask | Cerner commonly sends the note body as repeated OBX-5 lines or as an embedded PDF (verify at MLKCH). Handle both; store raw. |
| **ORU^R01** | Document of type radiology report from OBR (exam, ordering provider, result status) and OBX (report text); link to the ORM order when present; CodingTask for radiology | Only final and corrected results create or reopen tasks; preliminary results are stored. |
| **SIU^S12, S13, S14, S15, S26** (and S17 delete, verify) | Appointment upsert from SCH, PID, PV1, RGS/AIS/AIL/AIP; cancellations and no-shows close the appointment | Used for the eligibility worklist; not a coding trigger. |
| **ORM^O01** | Order record for radiology (optional in v1): lets the reconciliation report compare ordered against performed against coded | Low priority; useful for charge-capture leakage later. |
| **ADT^A03** | Already handled; additionally marks the encounter "visit complete" so a task can be created even when no MDM arrives within N hours (configurable), flagged "awaiting documentation" | Covers providers who sign late. |
| **DFT^P03** | Already handled; a DFT on an encounter with an open CodingTask attaches the Cerner charges to the task as `cerner_dft` CodeAssignments for the coder to confirm or correct, rather than billing them directly | This is the key behavioural change from v0.1: **nothing goes to a claim without passing through a CodingTask** unless the tenant is configured for pass-through billing. |

Cross-cutting requirements:
- **Z-segments**: parse and archive; map only what the Cerner interface specification says (verify). Never fail a
  message on an unknown Z-segment.
- **Ordering**: process messages for one encounter in arrival order; a DFT or MDM that arrives before any ADT for
  its account creates a stub encounter from PID/PV1 and flags it, rather than rejecting (the current code already
  upserts demographics from DFT; extend to MDM and ORU).
- **Per-tenant sender mapping** as in 5.1; **per-tenant field position overrides** for the handful of fields Cerner
  sites place differently (configuration table, not code forks).
- **Daily reconciliation job**: counts by message type received versus Cerner's interface log where MLKCH can
  provide it (verify), and charges received versus charges coded versus charges claimed, per day. Exposed as an
  API report and alerted on when a day's charge count drops below a tenant threshold.
- **Replay** already exists per message; add replay by time range and message type for re-mapping after a mapping fix.

## 7. Coding workbench

The product's centre. API first (section 11), then a minimal web UI (section 10.4). Designed around Harpreet's team.

### 7.1 Task lifecycle
```
awaiting_documentation --> ready_to_code --> in_progress --> coded --> released
         |                                     |    ^           |
         |                                     v    |           +--> qa_review --> released
         +------------------------------> on_hold_query --------+        |
                                                                          +--> returned_to_coder --> in_progress
```
- A task is created by the first final document (MDM or ORU) or by A03 plus timeout; it enters `ready_to_code`
  when at least one final document is present and the encounter has coverage, else `awaiting_documentation`.
- `on_hold_query` is entered by raising a ProviderQuery; answering it returns the task to `in_progress`. A hold
  has a clock; overdue holds appear on the coding lead's list.
- `coded` means the coder has released codes; a configurable QA sampling rule (percentage by coder, by specialty,
  all work for new coders, all high-value codes) routes to `qa_review`.
- `released` creates or updates Charges (`source = 'coder'`) priced from the fee schedule and triggers claim build
  (section 8). Release is the single hand-off from coding to billing and is recorded as an event with the full code
  set at that moment.
- Reopening: a corrected document (new Document version) or a denial for a coding reason reopens the task to
  `in_progress` with the reason; released charges on an unsubmitted claim are voided and rebuilt; on a submitted
  claim they drive a corrected claim (frequency code 7) in a later milestone.
- Every status change goes through one `transitionTask` function with a transition table and an event row,
  mirroring `claims/state.ts`.

### 7.2 Coding screen requirements
- Patient header (name, DOB, MRN, account, payer, plan, IPA, eligibility status if known), encounter facts (date,
  provider, location, specialty), and every Document for the encounter, latest version first, in a readable pane
  beside the code entry pane. No navigation away from the task to read a note.
- Code entry: CPT/HCPCS with modifiers and units, ICD-10 with sequencing, diagnosis pointers per line, rendering
  provider defaulted from the document author. Code set lookup with descriptions (section 7.4).
- Edits fire on entry and on release: reuse the `ScrubRule` shape with a coding-time context. Initial rule set:
  code validity for the service date, NCCI procedure-to-procedure bundling and MUE unit limits, modifier
  applicability, diagnosis specificity (no unspecified code when a specific sibling exists, warning), E/M level
  guardrails (warning), payer-specific rules from the Payer record, FQHC encounter-code presence when the tenant is
  an FQHC (verify the Medi-Cal T1015 pattern with Harpreet).
- Cerner-sourced charges (from DFT) shown as proposals the coder confirms, changes or removes; the decision is
  recorded with provenance.
- AI suggestions (section 7.5), when enabled, shown the same way: proposals with the supporting sentences
  highlighted in the document pane; accept, change or reject, each recorded.
- Provider query composer with templates; the task goes on hold.
- Release button runs the edits; errors block, warnings require an acknowledgement reason.
- Keyboard-first; a coder should complete a routine primary-care encounter without touching the mouse.

### 7.3 Work distribution and metrics
- Queues by tenant and specialty; assignment by lead or self-pull in priority order (oldest service date first,
  timely-filing risk first). A task can be reassigned by a lead only.
- Metrics stored as events and computed on read: tasks released per coder per hour, median time in each status,
  hold rate, QA accuracy (agreement after review), reopen rate, days from service to release. These feed the
  KinetikData dashboard (section 9.3).

### 7.4 Code sets and edits content
- CPT and HCPCS descriptions and the NCCI edit tables are licensed content (CPT from the AMA; NCCI tables are
  published by CMS). Load them from files into versioned tables (`code_set_versions`) with effective dates; never
  commit them to the repository. The build must run without them (empty tables, edits disabled with a visible
  banner) so development and tests stay licence-free.
- ICD-10-CM is public; load the annual release the same way.

### 7.5 AI suggestion slot (design now, implement in M8)
- An `AiSuggestion` is produced by a service that reads the task's documents and returns codes with text spans and
  confidence. The interface is a function `suggest(task, documents) -> AiSuggestion`; the first implementation may
  be a hosted model call from inside the Azure tenant under a BAA with the model provider, or a local model; the
  workbench does not care.
- Hard rules: a suggestion never creates a Charge; only a coder's decision does. Suggestions and decisions are both
  stored so acceptance rate and disagreement patterns can be measured. Accuracy is measured against the QA sample,
  not against coder agreement.
- PHI handling for the model call is part of the compliance package (section 10.2) and must be reviewed before M8.

## 8. Claims engine changes

- **Charge sources.** `buildClaim` consumes released coder charges (and Cerner charges only for pass-through
  tenants). Amounts come from FeeScheduleLine by code, modifiers and service date; a missing fee is a scrub error.
- **One claim per encounter per payer** stays. Add payer resolution: Coverage -> PayerAlias -> Payer; unmapped
  payer is a scrub error that lands on a biller's worklist.
- **837P content additions** (verify each against the clearinghouse companion guide and the Medi-Cal provider
  manual): billing provider from ProviderDirectory per tenant (2010AA) with taxonomy; rendering provider per line
  (2420A) when it differs from the claim level; referring provider (2310A) when present; prior authorization
  number (REF*G1) and referral number (REF*9F) from the encounter or coverage; NDC on drug lines (LIN/CTP in 2410);
  place of service per line (SV1-5) from Facility; patient relationship and secondary-payer loops when ClaimCharge
  enables them; FQHC encounter line pattern when the tenant is an FQHC; claim frequency code 7 for corrected claims
  with the payer claim control number (REF*F8).
- **Persisted control numbers**: ISA13, GS06 and ST02 from a sequence table per clearinghouse connection; CLM01
  stays the claim control number already generated.
- **Submission module** (`src/claims/submit.ts` grows into `src/submission/`): batch ready claims per
  clearinghouse into one interchange; write the file; transport by SFTP (most common) or the clearinghouse API;
  record ClaimBatch; move claims to `submitted`. Transport is a pluggable interface with a filesystem
  implementation for tests. Retry with idempotency on the batch id; never re-send a batch that was acknowledged.
- **Acknowledgement parsing**: 999 (interchange accepted or rejected, with IK3/IK4 errors mapped to claims where
  possible) and 277CA (per-claim accept or reject with STC codes) parsed into Acknowledgement rows and claim
  transitions; the existing manual `POST /claims/:id/acknowledge` stays as the override.
- **835 posting** (exists) gains: payer and check level records (BPR, TRN already parsed; add PLB provider-level
  adjustments), service-line level (SVC) matching to charges, unmatched remittances to an exceptions queue, and
  automatic DenialWorkItem creation for CLP02 = 4 and for lines with CO or PR adjustments carrying denial-category
  CARC codes (table-driven).
- **Secondary billing** enabled by ClaimCharge: build the secondary claim from the primary's adjudication
  (2320/2330 loops with the primary's CAS and payment); scheduled for after v1.0 but the data model lands in M1.
- **Eligibility (270/271)** through the clearinghouse for Appointments in the next N days: request builder,
  response parser into a Coverage verification record, and a worklist of failures. Medi-Cal eligibility specifics
  (aid codes, plan assignment, share of cost) verify with Harpreet.

## 9. Denials, AR, reporting

### 9.1 Denial work
Worklists by tenant, category, payer, owner and timely-filing deadline. Actions: correct and resubmit (reopens the
coding task when the category is coding), appeal (assemble a packet: claim, remittance, documents; record the
submission channel and date), write off (reason-coded, lead approval above a threshold), note. Every action is a
DenialWorkItem event.

### 9.2 AR
Aging by payer, by financial class, by service month, at claim and at line level; expected-versus-paid variance
when ContractRate is loaded; follow-up worklist ordered by age and balance; claim status inquiry (276/277) in a later
milestone.

### 9.3 Reporting
Read models (SQL views or materialised tables refreshed on a schedule) for: feed health (messages per type per day,
error and unsupported counts, last message time per feed); coding productivity and quality (7.3); days from service
to release, to submission, to payment; first-pass acceptance (277CA accepted over submitted); denial rate and top
CARC codes; collections by payer by month; AR aging. Exposed as authenticated JSON endpoints that the KinetikData
dashboard reads, and as CSV export restricted to roles that may export (not coders). Every export is an AccessLog row.

## 10. Platform, security, operations

### 10.1 Runtime and data store
- Keep Node 24 and TypeScript run directly. Introduce runtime dependencies only where writing them is unreasonable:
  SFTP client, OIDC token verification, Postgres driver. Record each exception in the README with the reason.
- **Move from SQLite to PostgreSQL before any multi-user production use.** SQLite is right for the single-writer
  service that exists today; a coding team writing concurrently, access logging on every read, and point-in-time
  recovery are Postgres jobs. Do it early (M3) while the `Store` is still the only code that knows column names.
  Azure Database for PostgreSQL Flexible Server, private endpoint, encryption at rest by default, automated backups
  with point-in-time restore, geo-redundant backup on.
- Archive raw HL7 and X12 files to Azure Blob Storage with immutability policy and the retention the BAA requires
  (verify: commonly six years for HIPAA documentation).

### 10.2 Security and compliance package
- Identity: OpenID Connect against Microsoft Entra ID; MFA required; conditional access by named location for
  coder roles (India office networks and approved VPN only, verify with Dilpreet what PhysiAssist already has);
  short sessions; no shared accounts.
- Authorisation: roles `coder`, `coding_lead`, `biller`, `ar_specialist`, `tenant_viewer` (client read-only),
  `kinetik_admin`; tenant scoping on every query; the `coder` role has no export or download capability and sees
  only its assigned tenant.
- Transport: HTTPS only, TLS 1.2 or later, behind Azure Application Gateway or a reverse proxy; MLLP accepted only
  from the VPN peer address range, optionally wrapped in TLS where Cerner's engine supports it (verify).
- Data: encryption at rest (Postgres, Blob, disks); secrets in Azure Key Vault; no PHI in logs (log ids, never names
  or MRNs; the current `log()` prints summaries, audit them); AccessLog for every PHI read and write; database
  roles separated for the application, migrations and reporting.
- Governance: HIPAA Security Rule risk analysis document; policies (access, incident response, breach
  notification, retention, vendor management); BAA chain (MLKCH to KinetikData to PhysiAssist to Microsoft to any
  model provider); penetration test before production; vulnerability scanning in CI; annual review. Target a SOC 2
  Type 1 readiness assessment after v1.0, since hospital procurement will ask.
- Development hygiene: synthetic data only in fixtures and tests (the current fixtures are fine); production data
  never on developer machines; the de-identification tool in `Tools/deid/` for any analysis outside the tenant.

### 10.3 Deployment and environments
- Azure, US region. One resource group per environment: `dev`, `test` (connected to Cerner's non-production
  domain when MLKCH grants it), `prod`. Infrastructure as code (Bicep or Terraform) from M3.
- The service runs as a container (Azure Container Apps or an App Service) with the MLLP listener on a VNet-internal
  address reachable only over the VPN; Azure VPN Gateway to MLKCH or Oracle Health as agreed on the technical call.
- Observability: structured logs to Log Analytics; metrics for feed health (messages per minute per type, ACK
  latency, error rate, time since last message), queue depths (tasks by status), and submission results; alerts on
  feed silence beyond a threshold during business hours and on any AR or AE ACK rate above a threshold.
- CI: `npm run check` on every push; e2e on a schedule; migration dry-run against a copy of test data; dependency
  and container scanning.

### 10.4 User interface
- Single-page web application served by the same origin, talking to the API; framework to be chosen (decision D3).
- v1 screens: sign-in; my queue; coding task (7.2); provider queries; coding lead dashboard (queues, holds, QA);
  biller worklists (scrub failures, unmapped payers, rejections); denial worklist; AR views; feed health; tenant
  and user administration. Client viewers get read-only reporting pages only.

## 11. API additions (all authenticated, all tenant-scoped, all logged)

| Method | Path | Purpose |
|---|---|---|
| GET | `/documents?encounterId=`; `/documents/:id` | Documents for an encounter; one document with versions |
| GET | `/appointments?from=&to=&status=` | Scheduling view for eligibility work |
| GET | `/coding/tasks?status=&assignee=&specialty=&tenant=` | Queues |
| POST | `/coding/tasks/:id/assign`, `/start`, `/hold`, `/resume`, `/release`, `/reopen` | Task lifecycle |
| GET, POST | `/coding/tasks/:id/codes` | Current code set; add or change (new CodeAssignment rows) |
| POST | `/coding/tasks/:id/queries`; `POST /coding/queries/:id/answer` | Provider query lifecycle |
| GET | `/coding/tasks/:id/suggestions`; `POST .../suggestions/:id/decide` | AI suggestions and decisions (M8) |
| POST | `/coding/tasks/:id/qa` | QA review findings |
| GET | `/codesets/search?system=&q=&date=` | Code lookup with descriptions |
| GET, PUT | `/tenants/:id/payers`, `/providers`, `/facilities`, `/fee-schedule` | Directories |
| POST | `/submission/batches` ; GET `/submission/batches/:id` | Build and send a batch; status with 999 and 277CA |
| POST | `/acknowledgements/999`, `/acknowledgements/277ca` | Parse acknowledgement files (manual upload path; the SFTP poller uses the same code) |
| GET | `/denials?category=&owner=&dueBefore=`; POST `/denials/:id/actions` | Denial worklist and actions |
| GET | `/ar/aging?by=payer|class|month`; `/ar/followup` | AR views |
| GET | `/reports/*` | Read models in 9.3 |
| GET | `/admin/feeds`, `/admin/reconciliation?date=` | Feed health and daily reconciliation |
| POST | `/admin/messages/replay?from=&to=&type=` | Range replay |
| GET | `/me` | Current user, roles, tenant scope |

Existing endpoints keep their shapes but gain authentication, tenant scoping and AccessLog writes. Domain errors keep
mapping to HTTP statuses in `router.ts`.

## 12. Milestones and acceptance criteria

Each milestone is done when its acceptance tests pass in CI and the `README` reflects it. Order is chosen so that a
demonstrable coding workbench exists before the proposal meeting, and so that the fallback in section 3 is
available at every step.

| # | Milestone | Done when |
|---|---|---|
| **M1** | **Documents and coding tasks (API)** | MDM^T02 and ORU^R01 fixtures ingest into Documents; tasks are created and move through the 7.1 lifecycle by API; CodeAssignment rows with provenance; release creates coder-sourced charges priced from a fee schedule; ClaimCharge link table in place; `npm run e2e` extended from feed to coded encounter to posted payment. |
| **M2** | **Workbench UI, minimal** | A coder signs in (dev auth), pulls a task, reads the note beside the code pane, enters codes, raises a query, releases; edits fire with the licence-free rule subset; lead sees queues and holds. Usable by Harpreet's team on synthetic data for feedback. |
| **M3** | **Tenancy, identity, audit, Postgres** | Tenant scoping on every table and query; OIDC against Entra ID with MFA; roles enforced; AccessLog on every PHI read and write; Postgres migration with the e2e suite green on it; infrastructure as code for `dev` and `test`. |
| **M4** | **Clearinghouse connection** | Clearinghouse chosen (decision D1) and test account live; batches built with persisted control numbers; SFTP or API transport; 999 and 277CA parsed into claim transitions; 835 pulled and posted; the 837P passes the clearinghouse's test validator for a primary-care and a radiology professional claim. |
| **M5** | **Medi-Cal and MLKCH claim content** | Payer directory with Medi-Cal and the MLKCH plans and IPAs; payer-specific scrub rules; FQHC pattern if applicable; prior auth and referral references; rendering and referring provider loops; a synthetic MLKCH-shaped claim set accepted by the clearinghouse test environment. Target: before the proposal is presented. |
| **M6** | **Production readiness** | `prod` environment; VPN established with MLKCH or Oracle Health (verify owner); Cerner non-production feed received and mapped, with per-site overrides; penetration test complete and findings closed; risk analysis and policies signed off; backup restore drill done; runbooks for feed silence, ACK failures, and batch rejection. |
| **M7** | **Denials, AR, reporting** | Automatic DenialWorkItem creation from 835; worklists and actions; AR aging and follow-up; the 9.3 read models serving the KinetikData dashboard; CSV export with AccessLog. |
| **M8** | **AI coding assistance** | `suggest()` implemented behind the slot; suggestions shown with text spans; decisions recorded; acceptance and QA-measured accuracy reported per specialty; PHI handling for the model call reviewed and documented. Rollout to one specialty (radiology) first. |

Go-live for MLKCH requires M1 to M6. M7 may follow within the first 60 days of live operation if denial work is
handled from the claims list in the interim; M8 is post-go-live.

## 13. Open decisions (owner, needed by)

- **D1. Clearinghouse** (Ken with Harpreet, before M4): Availity, Office Ally or Waystar, chosen on Medi-Cal and
  California plan connectivity, SFTP or API availability, 835 enrollment support, and cost. PhysiAssist's existing
  accounts weigh heavily.
- **D2. Go-live path** (Ken, at proposal time): this system end to end, or licensed PM for submission with this
  system as workbench (section 3). Decided by M1 to M5 status in late November.
- **D3. UI stack** (engineering lead, before M2): keep the no-dependency stance with a small framework-free front
  end, or adopt a mainstream framework. Recommendation: a small, well-understood framework; the no-dependency rule
  was for the service, and a workbench UI is where it costs the most.
- **D4. Postgres timing** (engineering lead, M3): as specified, before multi-user use; confirm.
- **D5. FQHC status of the MLKCH clinic** (Ken, on 11/12): changes claim content in M5.
- **D6. Offshore access policy** (Ken with Dilpreet, before the proposal): what MLKCH's policies and the Medi-Cal
  plans' agreements permit; shapes the conditional-access rules in 10.2 and the proposal's security section.
- **D7. Code set licences** (Ken, before M2's edits are turned on): AMA CPT licence scope for a billing company;
  NCCI tables are public from CMS (verify current terms).
- **D8. Reconciliation source at Cerner** (technical call with MLKCH IT): whether an interface log or charge
  report is available for the daily reconciliation.
- **D9. Who owns the interface change at MLKCH and on what timeline** (technical call): re-point, clone or new
  build by Oracle Health; sets M6's date.

## 14. Risks

- **Interface timeline outside our control.** Oracle Health work orders can take longer than the whole M1 to M5
  plan. Mitigation: incremental start on aged AR from an export; the fallback path in section 3.
- **Untested against live Cerner.** Fixtures are hand-built. Mitigation: get sample messages from MLKCH IT at the
  technical call and run them through ingest before M5 ends.
- **Clearinghouse certification surprises.** 837P output has never met a validator. Mitigation: M4 is early and
  gated on validator passes, not on code review.
- **Single-developer bus factor and AI-generated code drift.** Mitigation: the architectural qualities in section
  2 are review criteria; every module keeps tests beside it; `npm run check` gates merges.
- **Compliance scrutiny on offshore coders.** Mitigation: D6 before the proposal; access-not-download design;
  AccessLog from M3.
- **Scope creep into a general PM.** Mitigation: section 1's out-of-scope list; statements, portals and 837I wait.

## Appendix A. Fixtures to add
`mdm-t02-progress-note.hl7`, `mdm-t02-corrected-note.hl7`, `oru-r01-radiology-final.hl7`,
`oru-r01-radiology-preliminary.hl7`, `siu-s12-new-appointment.hl7`, `siu-s15-cancel.hl7`, `dft-p03-on-open-task.hl7`,
plus an X12 999 accepted, a 999 rejected, a 277CA mixed, and an 835 with a denied line and a PLB. All synthetic.

## Appendix B. Related documents

_These live in KinetikData's OneDrive workspace under `KinetikData RCM/`, not in this repository; the paths below
are relative to that folder. The canonical copy of this spec is `Output/2026-11-05_KD-RCM_KinetikBilling_Developer_Spec.md`
there; `docs/SPEC.md` is the copy committed with the code._

- `MLKCH/Meetings/2026-11-04_KD-MLKCH_Prep_HL7_Plain_Language_Primer.md`: the billing process and HL7 in plain words.
- `MLKCH/Meetings/2026-11-04_KD-MLKCH_Prep_HL7_Cerner_Cheat_Sheet.md`: message types, segments, Cerner specifics.
- `MLKCH/Output/2026-11-04_KD-MLKCH_Technical_Discovery_Questionnaire_HL7.md`: the questions whose answers close
  decisions D5, D8 and D9.
- `MLKCH/Meetings/2026-11-04_KD-MLKCH_Prep_Billing_Platform_Options_Memo.md`: Options 0 to 4, the eight knockout
  criteria, what to say on 11/12.
- `MLKCH/Meetings/2026-11-04_KD-MLKCH_Prep_OpenEMR_PM_Capability_Assessment.md`: why OpenEMR is not a day-one platform
  (no Cerner HL7 inbound; 837I unproven) and what it would take to make it one.
- `Tools/deid/README.md`: de-identification for any analysis outside the tenant.
