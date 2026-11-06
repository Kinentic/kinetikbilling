# Kinetik Billing

A revenue cycle management (RCM) billing service fed by Cerner Millennium HL7 v2 messages. It listens for ADT, BAR and DFT feeds over MLLP, keeps patients, encounters, coverage and charges in SQLite, and takes each claim from charge capture through scrubbing, 837P submission and 835 payment posting. A REST API exposes the billing operations.

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
4. **Dispatch** (`src/ingest/registry.ts`) looks the message type up in a table. ADT A01, A04, A08, A28, A31 and BAR P01, P05 share one handler that upserts whatever segments are present. A03 sets the discharge time. A40 merges a duplicate patient into the survivor and moves its encounters. DFT P03 upserts demographics and then the FT1 charge lines.
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

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/hl7` | Raw HL7 message as `text/plain`; same pipeline as MLLP |
| GET | `/messages?status=&limit=` | Audit log of received messages |
| POST | `/messages/:id/replay` | Re-run a stored message through ingest |
| GET | `/patients`, `/patients/:id` | Patients, with encounters on the detail view |
| GET | `/encounters?patientId=`, `/encounters/:id` | Encounters, with coverage, guarantor, diagnoses, charges and claims on the detail view |
| GET | `/charges?encounterId=&status=` | Charge lines |
| POST | `/encounters/:id/claims` | Build or extend the open claim; body `{ type?, coveragePriority? }` |
| GET | `/claims?status=`, `/claims/:id` | Claims, with charges, events and payments on the detail view |
| GET | `/claims/:id/837p` | Render the 837P without changing state |
| POST | `/claims/:id/submit` | Render the 837P and mark the claim submitted |
| POST | `/claims/:id/acknowledge` | Record a 999/277CA outcome; body `{ accepted, detail? }` |
| POST | `/claims/:id/rescrub`, `/claims/:id/rework`, `/claims/:id/close` | Lifecycle operations |
| POST | `/remittances/835` | Post an X12 835 interchange as `text/plain` |
| POST | `/remittances` | Post one adjudicated claim as JSON in the `Remittance` shape |
| GET | `/ar/summary` | Claim count and outstanding balance by status |

Domain errors map to HTTP statuses in one place, `src/api/router.ts`: unknown ids are 404, illegal transitions and build conflicts are 409, bad input is 400.

## Layout

```
src/domain/    types shared by every module; branded ids, integer cents, the ClaimStatus union
src/db/        SQLite schema and the Store, the only code that knows column names
src/hl7/       HL7 v2 parser, dates, ACK, MLLP; no billing knowledge
src/ingest/    message handlers, Cerner field mapping, upserts, audit
src/claims/    lifecycle table, builder, scrubber, X12 writer, 837P, 835, posting
src/api/       router boundary and REST routes
fixtures/hl7/  Cerner-style sample messages with fake PHI
scripts/       send-hl7 (MLLP client) and e2e
```

## Where this is going

[`docs/SPEC.md`](docs/SPEC.md) is the developer specification for the versions after 0.1: document feeds (MDM, ORU, SIU), a coding workbench, multi-client tenancy and identity, clearinghouse transport, Medi-Cal claim content, denials and AR, and the hosting and security posture for PHI. It also lists the gaps below as its starting point.

## What is deliberately not here yet

- **Secondary and tertiary billing.** A charge carries one claim id, so once the primary claim takes it, a secondary claim finds nothing to bill. Crossover and COB need a charge-to-claim link table.
- **837I.** Facility claims use the institutional format. The segment writer and claim context are shared; the loop structure for 005010X223A2 is not written.
- **999 and 277CA parsing.** Acknowledgements are recorded through `POST /claims/:id/acknowledge`; the files themselves are not parsed.
- **Patient statements** and a fee schedule. Charge amounts come from FT1-11 as Cerner sends them.
- **Control number sequencing.** X12 interchange numbers derive from the clock rather than a persisted sequence.
- **Transport security.** MLLP is plaintext and the HTTP API has no authentication. Run both behind a VPN or TLS-terminating proxy and encrypt the SQLite file at rest; the database holds PHI.

The fixtures are hand-built to HL7 2.5.1 field positions and have not been run against a live Cerner interface. The 837P output has not been through a clearinghouse validator.
