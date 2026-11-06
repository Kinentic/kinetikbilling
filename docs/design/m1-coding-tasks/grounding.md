# Grounding: the v0.1 service as the M1 design must find it

Phase A artifact for the architect run on SPEC.md milestone M1. Written from a full read of `src/` at commit d088498
(about 3,000 lines of source, 157 passing tests, `npm run e2e` green). Read this before `docs/SPEC.md` section 5 to 8
and before any sketch. Where this document and the code disagree, the code wins; say so in your rationale.

## Overview

Kinetik Billing is one Node 24 process with no runtime dependencies. An MLLP listener receives Cerner HL7 v2 messages,
an ingest layer maps them into domain rows in SQLite, and a claims engine turns unbilled charges into an 837P, moves
the claim through a closed status set, and posts 835 remittances. A REST API over `node:http` exposes the stored data
and the claim operations. Everything is synchronous around a single `Store`; `node:sqlite` runs each statement to
completion, so there is no concurrency inside the process today.

The v0.1 pipeline is Cerner-centred: charges arrive pre-coded on DFT^P03 and go straight to a claim. M1 inverts that.
A coder reads documents, decides the codes, and releases them; only then do charges exist to bill. The design must
graft that inversion onto the shapes below without forking them.

## Key concepts and the invariants they carry

- **`src/domain/types.ts` imports nothing.** Every module imports from it. Ids are branded strings
  (`PatientId`, `EncounterId`, `CoverageId`, `ChargeId`, `ClaimId`, `MessageId`), money is `Cents` (branded integer),
  dates are `IsoDate` / `IsoDateTime` brands. `newId<T>()` and `nowIso()` live in `src/domain/ids.ts`.
- **`Store` (`src/db/store.ts`) is the only code that knows column names.** It maps rows to domain types with
  `xFromRow` functions and exposes `get`, `find`, `list`, `save` (insert-or-update on primary key), `replace`
  (set replacement) and `append` methods. `transaction(fn)` nests (inner calls join the outer). Filters are small
  interfaces (`ListClaimsFilter`, `ListChargesFilter`). `schema.sql` is applied with `create table if not exists` on
  every open. **There is no migration mechanism.** Changing an existing table's columns today means a fresh database.
  M1 is pre-production, but the design must say how its schema change lands (a versioned migration list in the Store
  is the obvious shape; the reviewer will look for it).
- **Patient, Encounter, Coverage, Guarantor, Diagnosis, Charge, Claim, ClaimEvent, Payment, InboundMessage** are the
  domain rows. Encounter identity is `(facility, accountNumber)` (Cerner FIN). Coverage identity is
  `(encounterId, priority)` and keeps its id across replacements so claims stay attached. **Diagnoses belong to the
  encounter**, keyed `(encounterId, sequence)`; a charge's `diagnosisPointers` are sequences into that list, and the
  837P HI segment and SV1-7 pointers are built from them. Charge identity is `(encounterId, externalId)` where
  `externalId` is FT1-2, so a redelivered or corrected FT1 updates in place and keeps `status` and `claimId`.
- **Charge today carries `status: 'unbilled' | 'claimed' | 'voided'` and `claimId?: ClaimId`.** That single link is
  the README's first named gap: a secondary claim finds nothing to bill. SPEC 5.4 replaces it with a `ClaimCharge` link
  table and makes `Charge.status` derived. Every reader of `claimId` and `status` is listed under "Readers of the
  charge-to-claim link" below.
- **Claim status is a closed union with one writer.** `TRANSITIONS` in `src/claims/state.ts` is a
  `Record<ClaimStatus, readonly ClaimStatus[]>`; `transition(store, claim, to, reason, detail?)` re-reads the current
  status, checks the table, saves, and appends a `ClaimEvent`. `openClaim` writes the first event with `from: null`.
  SPEC 7.1 asks for the same shape for coding tasks (`transitionTask` with a table and an event row).
- **Scrubbing is a rule table.** `ScrubRule { id, severity, check(ctx: ClaimContext, cfg): ScrubViolation[] }` in
  `src/claims/scrub.ts`, with `rule()` and `perCharge()` helpers. `ClaimContext` (`src/claims/context.ts`) is the
  read model: claim, patient, encounter, coverage?, charges (attached, non-voided), diagnoses, guarantor?. SPEC 7.2
  wants coding-time edits in the same shape with a coding-time context.
- **Ingest handlers are `(store, msg, now) => { summary }`** (`src/ingest/handler.ts`), registered by
  `` `${MSH-9.1}^${MSH-9.2}` `` in `src/ingest/registry.ts`. `processMessage` (`src/ingest/process.ts`) parses,
  dedupes on `(MSH-4, MSH-10)`, stores an `InboundMessage` audit row for every outcome, runs the handler inside one
  transaction with the audit write, and never throws: a handler's `IngestError` becomes an AE with the message in
  MSA-3 and the row stays `error` so a sender retry reprocesses. An unknown type is stored `unsupported` and ACKed AA.
  A redelivered message with a non-error row is ACKed AA as `duplicate` without running the handler.
- **Mappers are pure.** One file per segment family in `src/ingest/map/` returns a `MappedX` type (the domain type
  minus ids and ownership) from an `Hl7Segment`. `upsert.ts` is the only ingest module that reads or writes the store,
  with the overlay rule: an incoming value replaces a stored one only when present, so an omitting message never
  erases a field. `ingestDemographics` (handlers/demographics.ts) is shared by ADT, BAR and DFT and upserts patient,
  encounter, coverages, guarantor and diagnoses from whatever segments are present.
- **The HTTP boundary is thin.** `Router` (`src/api/router.ts`) matches `/path/:param`, parses JSON or passes text,
  and maps thrown error *class names* to statuses through `STATUS_BY_ERROR_NAME`. A new domain error class must be
  added there or it is a 500. Routes (`src/api/routes.ts`) narrow input with `oneOf`, `int`, `requireString`,
  `requireObject`, call one domain function, and return plain data. Config is `AppConfig` from the environment with
  development defaults (`src/config.ts`); `BillingProviderConfig` is the submitter and billing provider identity.

## How a message becomes a paid claim today

```mermaid
flowchart LR
  MLLP[MLLP frame] --> P[parseHl7]
  P --> PM[processMessage: audit row, dedupe]
  PM --> H{HANDLERS[type]}
  H -->|ADT/BAR| D[ingestDemographics: upsert patient, encounter, coverages, guarantor, dx]
  H -->|A03| D
  H -->|A40| M[merge: encounters and claims move to survivor]
  H -->|DFT P03| C[charges: ingestDemographics then mapFt1 x N then upsertCharges]
  C --> CH[(charges: status unbilled)]
  API[POST /encounters/:id/claims] --> B[buildClaim]
  CH --> B
  B --> CL[(claims draft -> ready or scrub_failed)]
  CL --> S[POST /claims/:id/submit: build837P + markSubmitted]
  S --> A[acknowledge]
  A --> R[postRemittance from 835 or JSON]
  R --> CL
```

1. `buildClaim(store, cfg, encounterId, { type?, coveragePriority? })` loads the encounter and the coverage at the
   priority, lists `charges` with `status = 'unbilled'`, finds an existing OPEN claim (`draft`, `scrub_failed`,
   `ready`) for the same coverage and type, else opens one with control number `<FIN>-<n>`. It then sets every
   unbilled charge to `status: 'claimed', claimId` and calls `rescrub`, which recomputes `totalCharge` from the
   attached charges and transitions to `ready` or `scrub_failed`.
2. `loadClaimContext(store, claimId)` lists `charges` by `claimId` and filters `voided`. `build837P` reads from the
   context: `charge.code`, `modifiers`, `units`, `amount`, `serviceDate`, `diagnosisPointers`, `performingProvider`
   (rendering provider at 2310B when its NPI differs from billing).
3. `postRemittance` finds the claim by `controlNumber` (CLP01), dedupes on payer control number plus check plus status
   code, applies paid, adjusted and patient-responsibility deltas, and transitions to `paid`, `partially_paid` or
   `denied`.
4. `reworkClaim` sends `rejected`, `denied` or `scrub_failed` back to `draft` and rescrubs. Nothing today voids a
   charge; `voided` is a status with no writer.

## Readers of the charge-to-claim link (what ClaimCharge must replace)

| Reader | What it does with `claimId` / `status` |
|---|---|
| `claims/build.ts` `buildClaim` | `listCharges({ encounterId, status: 'unbilled' })`; writes `status: 'claimed', claimId` |
| `claims/context.ts` `loadClaimContext` | `listCharges({ claimId })` then drops `voided` |
| `ingest/upsert.ts` `upsertCharges` | preserves `existing.status` and `existing.claimId` on redelivery |
| `api/routes.ts` `GET /claims/:id` | `listCharges({ claimId })` for the detail view; `GET /charges?status=` filter |
| `db/store.ts` | `charges.claim_id` column, `charges_claim` index, `ListChargesFilter.claimId` |
| `claims/testkit.ts` `addCharge` | seeds `status: 'unbilled'` |
| `scripts/e2e.ts` | reads `enc.charges` count and net amount; drives the claim by id |

`Charge.amount` is signed: CG positive, CD negative, so a credit nets against its charge on the same claim.

## Where things live

```
src/domain/types.ts      every type; add new ids and rows here first
src/domain/ids.ts        newId, nowIso
src/db/schema.sql        DDL; applied on open; no migrations yet
src/db/store.ts          row mappers and the Store class; one section per aggregate
src/hl7/                 parser, datetime, ACK, MLLP; exports via index.ts; segments(), firstSegment(), comp(), reps(), repComp()
src/ingest/process.ts    audit, dedupe, dispatch, ACK
src/ingest/registry.ts   type -> handler table
src/ingest/handler.ts    MessageHandler, HandlerResult, IngestError
src/ingest/upsert.ts     the only ingest writer; overlay rule; upsertCharges
src/ingest/map/*.ts      pure segment mappers (pid, pv1, in1, gt1, dg1, ft1, xcn, xpn, xad, xtn, money, text, relationship)
src/ingest/handlers/*.ts demographics, discharge, merge, charges
src/claims/state.ts      TRANSITIONS, transition, openClaim, errors
src/claims/build.ts      buildClaim, rescrub, reworkClaim, OPEN
src/claims/context.ts    ClaimContext, loadClaimContext
src/claims/scrub.ts      ScrubRule, RULES, scrubClaim
src/claims/edi837p.ts    build837P(ctx, cfg, controls)
src/claims/edi835.ts     parse835 -> Remittance[]
src/claims/post.ts       postRemittance, outstanding
src/claims/submit.ts     markSubmitted, acknowledge, closeClaim
src/claims/index.ts      public surface of claims
src/claims/testkit.ts    seed(), addCharge(), cfg, SAMPLE_835
src/api/router.ts        Router, HttpError, STATUS_BY_ERROR_NAME, requireString, requireObject
src/api/routes.ts        buildRouter({ store, config, ingest })
src/config.ts            AppConfig, loadConfig(env)
src/main.ts              startApp(config) -> { mllpPort, httpPort, store, stop }
scripts/e2e.ts           fixtures through MLLP in order, then claim to payment over HTTP
fixtures/hl7/*.hl7       seven HL7 2.5.1 messages, CR-separated segments, fake PHI (MRN 1000001, FIN000123)
```

Tests sit beside their module as `*.test.ts` on `node:test`, in-memory `Store(':memory:')`, fixtures loaded by URL
relative to the test file. `npm run check` is typecheck plus tests. tsconfig: `strict`, `noUncheckedIndexedAccess`,
`erasableSyntaxOnly` (no parameter properties, no enums, no namespaces), `verbatimModuleSyntax`, `.ts` import
specifiers, `exactOptionalPropertyTypes` off.

## Gotchas and constraints the design must honor

- **Diagnoses are encounter-level and pointer-addressed.** A coder's ICD-10 set with sequencing has to end up as the
  encounter's diagnosis list (or the design must give claims their own list and migrate the 837P HI builder and the
  three pointer scrub rules). Either way, say which, and what happens when a later DG1 arrives after release.
- **`upsertCharges` is the single charge writer for Cerner lines and keys on FT1-2.** Coder-sourced charges have no
  FT1-2. The `(encounterId, externalId)` unique key must still hold; the design must say what a coder charge's
  `externalId` is, or split identity by source.
- **Handlers run inside the audit transaction and must be replay-safe.** `POST /messages/:id/replay` re-runs a stored
  message. A replayed MDM must not create a second Document version or a second task; a replayed DFT must not
  duplicate proposals.
- **The e2e script asserts exact counts** (three charges netting 12500 on FIN000123, claim `ready`, `paid` after
  remittance). In coder mode the DFT fixture's lines become proposals, not charges; the e2e flow has to grow a coding
  step and the asserted numbers follow the fee schedule, not FT1-11.
- **`charges.claim_id` references `claims(id)` and `claims` references `coverages`.** Deleting a coverage is guarded
  by claims; nothing guards charge deletion because nothing deletes charges.
- **The router maps error names, not classes.** Two error classes with the same `name` collide. New domain errors need
  distinct names and a row in `STATUS_BY_ERROR_NAME`.
- **Config has no tenant.** Tenancy is M3. For M1 the "pass-through billing" switch from SPEC 6 is process-level
  configuration. Say where it lives and what reads it.
- **No scheduler exists.** SPEC 6 wants A03 plus N hours with no document to create an `awaiting_documentation` task.
  The process has no timers beyond the servers. The design must give this a shape (a sweep function callable by an
  API route and a timer in `main.ts` is the smallest) and say what runs it in e2e.
- **The 837P writer picks the rendering provider as the first charge whose performing NPI differs from billing.**
  Coder release defaults rendering provider from the document author (SPEC 7.2); that value has to land on the charge
  as `performingProvider` or the 2310B loop stays empty.

## Why the current shape is what it is (constraints, not guesses)

From the README and commit messages, verified against the code: wire formats are parsed into domain types at the
boundary and never leak past it; one closed status union with a single `transition` function; audit-everything
ingest that never rejects what it cannot bill from; integer cents; no runtime dependencies; small files with tests
beside them. SPEC 2 names these as the review criteria for new work. The single `claimId` on a charge was a knowing
simplification, documented as the first gap, not a principle. The encounter-level diagnosis list mirrors HL7 DG1
semantics and the 837P's per-claim HI segment; it was not designed with coders in mind.
