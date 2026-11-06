# Kinetik Billing

A revenue cycle management (RCM) billing service fed by Cerner Millennium HL7 v2 messages. It listens for ADT, BAR, DFT, MDM and ORU feeds over MLLP, keeps patients, encounters, coverage, documents, coding tasks and charges in SQLite, and takes each claim from charge capture through scrubbing, 837P submission and 835 payment posting. A REST API exposes the coding and billing operations.

No runtime dependencies. Node 24 or later runs the TypeScript directly and provides SQLite through `node:sqlite`.

## Run

```bash
npm install
npm start
```

The MLLP listener binds `0.0.0.0:2575` and the HTTP API `127.0.0.1:8080`. Every setting has a development default; copy `.env.example` and export the variables to change ports, the database path, or the billing provider identity written into the 837P.

Send the sample Cerner feed to a running instance:

```bash
node scripts/send-hl7.ts 127.0.0.1:2575 fixtures/hl7/adt-a04-register.hl7 fixtures/hl7/dft-p03-charges.hl7
```

Prove the whole cycle on ephemeral ports with an in-memory database:

```bash
npm run e2e
```

Checks:

```bash
npm run check
```

## How a message becomes a claim

1. **MLLP** (`src/hl7/mllp.ts`) frames bytes into messages, one connection at a time, and writes back the ACK the pipeline returns.
2. **Parse** (`src/hl7/parse.ts`) turns the raw text into segments, fields, repetitions, components and subcomponents with escape sequences resolved. The parser knows nothing about billing.
3. **Process** (`src/ingest/process.ts`) stores an audit row for every message, keyed on sending facility plus MSH-10. A redelivered message is acknowledged and not reprocessed. An unsupported message type is acknowledged, stored and left alone, because rejecting it would stall the Cerner outbound queue. A parse or mapping failure returns AE or AR with the reason in MSA-3 and leaves the error row in place so a retry runs again.
4. **Dispatch** (`src/ingest/registry.ts`) looks the message type up in the table `handlersFor(config.coding)` builds. ADT A01, A04, A08, A28, A31 and BAR P01, P05 share one handler that upserts whatever segments are present. A03 sets the discharge time and tells the coding intake the visit is complete. A40 merges a duplicate patient into the survivor and moves its encounters. DFT P03 upserts demographics and hands the FT1 lines to the intake, which bills them (pass-through) or proposes them to the coder. MDM T02/T04/T08/T10 and ORU R01 append a document version and hand it to the intake.
5. **Map** (`src/ingest/map/`) holds the Cerner field positions, one file per segment family. Charges are keyed on the FT1 transaction id, so a corrected line updates in place. CG lines are stored positive and CD credits negative regardless of the sign Cerner sent.
6. **Claims** (`src/claims/`) build one claim per encounter and coverage from the unbilled charges, scrub it against a rule table, and move it through a closed set of states. Every status change goes through `transition`, which records an event with the reason and detail.

## Claim lifecycle

```
draft ──▶ ready ──▶ submitted ──▶ accepted ──▶ paid ──▶ closed
  ▲         │           │             │
  └─ scrub_failed       └─ rejected   ├─▶ partially_paid ──▶ closed
                                      └─▶ denied ──▶ closed
```

Rejected, denied and scrub-failed claims go back to draft through `POST /claims/:id/rework`. The full transition table is `TRANSITIONS` in `src/claims/state.ts`.

## Coding (M1)

In coder mode (`BILLING_MODE=coder`, the default), Cerner charges no longer bill themselves. An A03, a DFT or a final MDM/ORU opens the encounter's single coding task. DFT lines arrive as proposals in the code log, keyed on FT1-2 so a redelivery appends nothing and a coder's decision survives it. A coder works the task over `/coding/tasks/:id`: starts it, holds it by raising a provider query and resumes it by answering, decides every line (accept, change, remove, add), and releases. Release runs the coding edits (`CODING_RULES` in `src/coding/edits.ts`, the same rule shape as the claim scrubber, shown on every read of the codes) and refuses with a 422 listing the findings while any error stands or a warning is unacknowledged; otherwise it prices each procedure line from the fee schedule, writes one coder charge per line carrying its diagnoses by value, moves the task through `coded` to `released` in one transaction, and then builds or extends the claim in its own transaction, so a missing coverage leaves the release standing with `claim: not_built` and a repeat release retries the build. Documents are immutable versions; a resent note with the same content writes nothing, a corrected note (MDM T08) becomes the next version, reopens a released task and parks its open claim in draft. `BILLING_MODE=pass_through` restores v0.1: DFT lines become charges, documents are stored, no tasks exist.

The fee schedule (`PUT /fee-schedule`, whole-set replacement) prices a code per unit by exact modifier set, falling back to the modifier-agnostic line, within an effective date range; a line with no fee on file blocks the whole release, and a charge keeps the price it was released at. `QA_SAMPLE_PERCENT` of releases stop in `qa_review` (chosen by a hash of task and release number, so a retry decides the same way); `POST /coding/tasks/:id/qa` returns the task to the coder with notes or agrees, which re-runs the edits and completes the release. A reopened task's next release voids only the charges whose billed facts changed (code, modifiers, units, date, amount, diagnoses, rendering provider), keeps the rest, and rescrubs the same claim back to ready; a charge already on a submitted claim locks the line (`billed-claim-locked`) until corrected claims exist.

```
awaiting_documentation ──▶ ready_to_code ──▶ in_progress ──▶ coded ──▶ released
          │                                   ▲    │  ▲         │         │
          └──▶ on_hold_query ◀────────────────┘    │  │         └─▶ qa_review ─┐
                     │                             │  │                        │
                     └─────────────────────────────┘  └─ returned_to_coder ◀───┘
                                                (released ──▶ in_progress is a reopen)
```

The transition table is `TASK_TRANSITIONS` in `src/coding/state.ts`; the decision matrix for feed events (which document or charge moves which status) is `reactToFact` in `src/coding/tasks.ts`. An A03 sets `documentationDueAt` to the discharge time plus `DOCUMENTATION_GRACE_HOURS`; there is no timer, the lead's overdue list is `GET /coding/tasks?status=awaiting_documentation&overdue=true&asOf=`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BILLING_MODE` | `coder` | `coder` or `pass_through` |
| `DOCUMENTATION_GRACE_HOURS` | `48` | Hours after discharge before a task still awaiting documentation is overdue |
| `QA_SAMPLE_PERCENT` | `0` | Share of releases that stop in `qa_review` before charges are written |

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/hl7` | Raw HL7 message as `text/plain`; same pipeline as MLLP |
| GET | `/messages?status=&limit=` | Audit log of received messages |
| POST | `/messages/:id/replay` | Re-run a stored message through ingest |
| GET | `/patients`, `/patients/:id` | Patients, with encounters on the detail view |
| GET | `/encounters?patientId=`, `/encounters/:id` | Encounters, with coverage, guarantor, diagnoses, charges and claims on the detail view |
| GET | `/charges?encounterId=&status=&source=` | Charge lines with their derived status (`unbilled`, `claimed`, `voided`) and claim links |
| POST | `/encounters/:id/claims` | Build or extend the open claim; body `{ type?, coveragePriority? }` |
| GET | `/claims?status=`, `/claims/:id` | Claims, with charges, events and payments on the detail view |
| GET | `/claims/:id/837p` | Render the 837P without changing state |
| POST | `/claims/:id/submit` | Render the 837P and mark the claim submitted |
| POST | `/claims/:id/acknowledge` | Record a 999/277CA outcome; body `{ accepted, detail? }` |
| POST | `/claims/:id/rescrub`, `/claims/:id/rework`, `/claims/:id/close` | Lifecycle operations |
| POST | `/remittances/835` | Post an X12 835 interchange as `text/plain` |
| POST | `/remittances` | Post one adjudicated claim as JSON in the `Remittance` shape |
| GET | `/ar/summary` | Claim count and outstanding balance by status |
| GET | `/documents?encounterId=`, `/documents/:id` | Current document versions with their history; one version with every version of its document |
| GET | `/coding/tasks?status=&assignee=&specialty=&overdue=true&asOf=` | Coding queues; `overdue=true` lists tasks awaiting documentation past their deadline as of `asOf` |
| GET | `/coding/tasks/:id?asOf=` | The coding screen in one read: task, events, patient, encounter, coverages, documents, codes, queries |
| POST | `/coding/tasks/:id/assign`, `/start`, `/reopen` | Task lifecycle; bodies `{ assignee }`, `{ coder }`, `{ reason, actor? }` |
| POST | `/coding/tasks/:id/release` | Run the coding edits and release; body `{ coder, warningsAcknowledged? }`; returns `blocked` as 422 with the violations, else `qa_review` or `released` with the charge delta and the claim hand-off |
| POST | `/coding/tasks/:id/qa` | QA review of a sampled release; body `{ reviewer, outcome: agree \| return, notes? }` (notes required on return) |
| GET, PUT | `/fee-schedule` | The process-wide fee schedule; `PUT { lines: [{ code, modifiers, amount, effectiveFrom, effectiveTo? }] }` replaces it |
| GET, POST | `/coding/tasks/:id/codes` | Current code set with its history and pending proposals; `{ coder, edits: [{ op: accept \| change \| remove \| add, ... }] }` appends decisions |
| POST | `/coding/tasks/:id/queries` | Raise a provider query, which holds the task; body `{ coder, question, channel, sentTo? }` |
| POST | `/coding/queries/:id/answer` | Answer it, which resumes the task; body `{ answer }` |

Domain errors map to HTTP statuses in one place, `src/api/router.ts`: unknown ids are 404, illegal transitions and build conflicts are 409, bad input and a refused fee schedule are 400. A release the coding edits refuse is not an error class but a returned value the route sends as 422.

## Layout

```
src/domain/    types shared by every module; branded ids, integer cents, the ClaimStatus union
src/db/        the Store, the only code that knows column names, and migrations/ (numbered SQL applied above pragma user_version)
src/hl7/       HL7 v2 parser, dates, ACK, MLLP; no billing knowledge
src/ingest/    message handlers, Cerner field mapping, upserts, audit; intake.ts is the one reader of the billing mode
src/coding/    task lifecycle table and matrix, the append-only code log, provider queries, the coder's read model, fee schedule, coding edits, release and QA
src/claims/    lifecycle table, builder, scrubber, X12 writer, 837P, 835, posting
src/api/       router boundary and REST routes
fixtures/hl7/  Cerner-style sample messages with fake PHI
scripts/       send-hl7 (MLLP client) and e2e
```

## Where this is going

[`docs/SPEC.md`](docs/SPEC.md) is the developer specification for the versions after 0.1: document feeds (MDM, ORU, SIU), a coding workbench, multi-client tenancy and identity, clearinghouse transport, Medi-Cal claim content, denials and AR, and the hosting and security posture for PHI. It also lists the gaps below as its starting point.

## What is deliberately not here yet

- **Secondary and tertiary billing.** The charge-to-claim link is a table (`claim_charges`), so a charge on the primary claim is billable to a secondary coverage, but nothing builds the COB loops of a secondary 837P yet.
- **837I.** Facility claims use the institutional format. The segment writer and claim context are shared; the loop structure for 005010X223A2 is not written.
- **999 and 277CA parsing.** Acknowledgements are recorded through `POST /claims/:id/acknowledge`; the files themselves are not parsed.
- **Patient statements.**
- **Diagnoses beyond the charges.** A charge carries its diagnoses by value and a claim's HI list is derived from its charges, so a diagnosis no FT1-19 or coded procedure line references does not reach the claim.
- **Two readings of SPEC 7.1.** Coverage is not a readiness input: a final document alone makes a task `ready_to_code`, and missing coverage is a coding-edit warning plus `claim: not_built` at release rather than a gate on the queue. "A03 plus timeout" is the task existing from the A03 in `awaiting_documentation` with overdue as a read filter, not a timer that creates it later.
- **Corrected claims.** A released line whose charge sits on a submitted claim cannot be changed (`billed-claim-locked`); frequency code 7 claims are a later milestone, so such a reopened task waits in `in_progress`.
- **Licensed code content.** The coding edits check shape and consistency only; NCCI, MUE and code validity arrive with code set loading.
- **Control number sequencing.** X12 interchange numbers derive from the clock rather than a persisted sequence.
- **Transport security.** MLLP is plaintext and the HTTP API has no authentication. Run both behind a VPN or TLS-terminating proxy and encrypt the SQLite file at rest; the database holds PHI.

The fixtures are hand-built to HL7 2.5.1 field positions and have not been run against a live Cerner interface. The 837P output has not been through a clearinghouse validator.
