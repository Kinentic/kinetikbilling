# M1 design: documents, coding tasks, release, ClaimCharge

Synthesized from four arena candidates (see "Synthesis decision") and implemented in three units (see
"Implementation reconciliation"). The type sketch that guided implementation was removed once the code landed; the
contracts now live as doc comments on the real files named in `module-map.md`. `grounding.md` is the Phase A read of
the v0.1 service this design started from; `arena-brief.md` is the task and rubric the candidates were judged on.

## Problem

v0.1 bills what Cerner prices: FT1 lines become charges and go straight to a claim. M1 puts a coder in between.
Documents (MDM, ORU) open a CodingTask; the coder decides codes in an append-only log; release turns the decided set
into fee-schedule-priced charges and hands them to the existing claim builder. A process-level pass-through switch
keeps v0.1 behaviour for tenants that want it. The shape is not obvious because the graft touches five things the
v0.1 code treats as single-owner: the encounter diagnosis list (DG1 writes it, the 837P HI and three scrub rules read
it by sequence number), charge identity `(encounter, FT1-2)`, the charge-to-claim link (one `claimId` column with a
stored `status` beside it), the handler contract `(store, msg, now)` inside the audit transaction, and a schema
applied with `create table if not exists` and no migrations. Constraints honoured from the code: `types.ts` imports
nothing; `Store` is the only SQL; claim status has one writer; the router maps error names; `erasableSyntaxOnly`.
Two corrections to the grounding, verified in `src/ingest/process.ts`: a replay of an `accepted` message is answered
`duplicate` by the `(MSH-4, MSH-10)` dedupe and never reaches a handler, so handler idempotence matters for sender
retries of `error` rows and for Cerner resending the same content under a new MSH-10; and `schema.sql` opens with
`pragma journal_mode = wal`, which SQLite refuses inside a transaction, so a migration runner must strip the pragmas.

## Usage (caller's view)

README section, "Coding (M1)":

> In coder mode (`BILLING_MODE=coder`, the default), Cerner charges no longer bill themselves. An A03, a DFT or a
> final MDM/ORU opens the encounter's single coding task. DFT lines arrive as proposals. A coder works the task over
> `/coding/tasks/:id`, decides every line, and releases. Release prices each procedure line from `/fee-schedule`,
> writes coder charges carrying their diagnoses, and builds or updates the claim. A corrected note reopens a released
> task and parks its claim in draft; the next release voids only the lines that changed and rebuilds the claim.
> `BILLING_MODE=pass_through` restores v0.1: DFT lines become charges, documents are stored, no tasks exist.

```http
PUT  /fee-schedule                 {"lines":[{"code":"99213","modifiers":[],"amount":12500,"effectiveFrom":"2026-01-01"}]}
GET  /coding/tasks?status=awaiting_documentation&overdue=true&asOf=2026-11-10T19:00:00Z
POST /coding/tasks/T/start         {"coder":"coder-1"}
GET  /coding/tasks/T/codes         -> {"lines":[...pending cerner_dft proposals...],"violations":[{"rule":"proposals-decided",...}]}
POST /coding/tasks/T/codes         {"coder":"coder-1","edits":[{"op":"accept","lineId":"L1","basedOn":"A1"},
                                     {"op":"add","content":{"kind":"diagnosis","code":"I10","sequence":2}}]}
POST /coding/tasks/T/queries       {"coder":"coder-1","question":"Confirm total time","channel":"in_app"}   (this is "hold")
POST /coding/queries/Q/answer      {"answer":"22 minutes"}                                                 (this is "resume")
POST /coding/tasks/T/release       {"coder":"coder-1"}
  -> {"kind":"released","releaseNumber":1,"charges":{"created":["C1"],"voided":[],"kept":[]},
      "claim":{"kind":"built","claim":{"id":"K1","status":"ready","totalCharge":12500}}}
  -> 422 {"error":"coding edits failed","detail":[{"rule":"fee-on-file","lineId":"L1",...}]}
```

Call site 1, the release route (`src/api/coding-routes.ts`). One domain call; the refusal is a value the route maps:

```ts
r.add('POST', '/coding/tasks/:id/release', ({ params, body }) => {
  const out = release(store, { billing: config.billing, qaSamplePercent: config.coding.qaSamplePercent },
    params.id as CodingTaskId, { coder: requireString(body, 'coder'), ...optionalString(body, 'warningsAcknowledged') });
  if (out.kind === 'blocked') throw new HttpError(422, 'coding edits failed', out.violations);
  return out;
});
```

Call site 2, the coder-mode intake for DFT (`src/ingest/intake.ts`). The handler never knows the mode, and the
intake makes one coding call:

```ts
onCharges(store, encounter, lines, ctx) {
  return cernerLinesArrived(store, encounter, toCernerLines(lines), ctx, coding).summary;
}
```

Call site 3, a test of the decision-5 matrix (`src/coding/tasks.test.ts`). The policy is a pure function, tested as
a table without a store:

```ts
test('a corrected document reopens a released task', () => {
  assert.deepEqual(reactToFact(task('released'), { kind: 'final_document', document: doc('final'), correction: true }),
    { kind: 'transition', to: 'in_progress', reason: 'document corrected', specialty: 'primary_care' });
});
```

## Shape

**Data first.** Five new tables and one rebuilt one (`src/db/migrations/0002_m1_coding.sql`), each with one
writer:

| State | Representation | Single writer |
|---|---|---|
| Document version | insert-only `documents`, unique `(encounter, externalId, version)`, update/delete triggers abort | `ingest/upsert.ts appendDocumentVersion` |
| Task status | `coding_tasks.status`, written only by `Store.recordTaskTransition`, which requires an event row | `coding/state.ts transitionTask` |
| Current code set | not stored; derived by `deriveCodeSet` from insert-only `code_assignments` | `coding/codes.ts` |
| Charge-to-claim link | insert-only `claim_charges` | `claims/build.ts buildClaim` |
| `Charge.status` | not stored; `charge_states` view (voided if `voided_at`, claimed if any link, else unbilled) | none (derived) |
| Coder charges | insert once; trigger allows only `voided_at` null to value | `coding/release.ts` |
| Cerner charges | upsert on `(encounter, 'cerner_dft', FT1-2)` | `ingest/upsert.ts upsertCharges` (pass-through only) |
| Claim diagnosis list (HI) | not stored; `claimDiagnoses(charges)` over each charge's by-value `diagnoses` | none (derived) |
| Encounter diagnoses (DG1) | unchanged table, clinical context only | `ingest/upsert.ts mergeDiagnoses` |

**Diagnoses travel by value.** `Charge.diagnosisPointers` becomes `Charge.diagnoses: ChargeDiagnosis[]` (code,
system, description, the sequence it had where it was decided). The claim's HI list is a pure derivation of its
attached charges (`claims/context.ts claimDiagnoses`), ordered by the coder's sequence then first appearance; a line's
SV1-7 pointers are the positions of its own codes. The encounter's DG1 list is no longer read by billing. This deletes
the cross-row pointer invariant rather than partitioning it: no rule can dangle after release, a late DG1 cannot
change a released claim's HI, and `buildClaim` needs to know nothing about which list a charge's pointers index. The
cost is a wider M1 diff (837P HI/SV1 builder, two scrub rules, `mapFt1`/`upsertCharges`, testkit, the charges
migration) and that a diagnosis no line points to does not reach the claim.

**The code log.** A `CodeAssignment` row is immutable. A logical line is the chain of rows sharing a `lineId`,
linked by `supersedes`; `UNIQUE(supersedes)` makes a fork impossible in SQL, and `supersededBy` is a join, not a
column. Provenance records origin and `decision?` records the coder's ruling, so a Cerner line the coder confirms
stays `cerner_dft` with a decision (acceptance rate is a join, as SPEC 5.3 asks). A proposal is a row without a
decision; release refuses while any current row lacks one. Procedure lines name their diagnoses by ICD-10 code, not
by sequence number, so re-sequencing diagnoses never touches procedure rows. Modifiers live on the procedure line;
SPEC's separate `modifier` kind is rejected because a modifier has no meaning apart from its line.

**Release is a plan, then a write.** `planRelease` (pure, total) computes the active diagnoses renumbered 1..n, a
priced line with its by-value diagnoses for every active procedure, which live coder charges to keep, and which to
void. The coding edits (`CODING_RULES`, `ScrubRule<CodingContext>` sharing `rule()`/`when()` with the claim
scrubber) validate that plan and `enterReleased` writes it: what is checked is exactly what is written. The edits
also show on `GET .../codes` (SPEC 7.2 "on entry").

**One task per encounter, and the matrix is one pure function.** `reactToFact(task | undefined, fact)` returns
create, transition or none for the decision-5 matrix (table in `src/coding/tasks.ts`). Three ingest-facing
verbs (`documentAppended`, `cernerLinesArrived`, `visitCompleted`) each record what the feed said and apply the
resulting fact inside the handler's audit transaction; the intake calls exactly one of them per message.

**Mode is read once.** `ingest/intake.ts intakeFor(config.coding)` returns a `CodingIntake` with three methods.
`registry.ts handlersFor(coding)` builds the one handler table with it and `processMessage` requires that table, so no
caller inherits a mode by accident. Pass-through disables task creation from every trigger, not just DFT, so a
pass-through tenant can never be double-billed by a coder release. Claims never read the mode:
`listBillableCharges(encounter, coverage)` bills whatever is live and not yet on a claim for that coverage, which is
also the predicate secondary billing will need.

**Reopen parks the claim.** A reopen (corrected document, or a person) moves released to in_progress and calls
`claims/build.ts draftClaim` on every OPEN claim holding a live coder charge of the encounter. A draft claim cannot be
submitted, so the stale claim waits for the next release, which voids and recreates only the lines whose billing facts
changed and rescrubs the same claim back to ready.

**Interface depth.** `coding/index.ts` exports the lifecycle verbs (`release`, `reviewQa`, `editCodes`,
`readCodes`, `startTask`, `assignTask`, `reopenTask`, `raiseQuery`, `answerQuery`, `loadTaskView`,
`replaceFeeSchedule`, the three ingest verbs) plus errors and types. Behind `release` sit pricing, modifier fallback,
diagnosis resolution, rendering-provider defaulting, the keep/void diff, QA sampling, the release record and the claim
hand-off. `plan.ts`, the `record*` functions, `applyCodingFact`, `enterReleased`, `handOff` and `sampled` are not
re-exported, and a test asserts nothing outside `src/coding` imports a coding file other than `index.ts`. HTTP to SQL
is three files: `api/coding-routes.ts`, `coding/<module>.ts`, `db/store.ts`.

**Validation** happens at the route (body narrowing, `parseCodeEdits`), at the mappers (HL7 to `MappedDocument`),
and at `replaceFeeSchedule`. Inside, types are trusted. Invariants live in types where TypeScript can carry them (the
`Charge` source union: `codeAssignmentId` and `voidedAt` exist only on coder charges; `ChargeState` versus the stored
`Charge`, so status cannot be written; `saveCernerCharge(c: CernerCharge)`; `Record<TaskStatus, ...>` for the table)
and in SQL where it cannot (CHECK constraints mirror the unions; triggers make the logs append-only). Principles
applied: encode-lessons-in-structure, separate-before-serializing-shared-state, make-operations-idempotent,
boundary-discipline, redesign-from-first-principles (by-value diagnoses).

### The eight decisions

1. **Coder ICD-10 codes.** They live as `diagnosis` lines in the code log while coding. Release copies the decided
   set, in coder sequence, by value onto each coder charge; the claim derives its HI from its charges; the encounter
   DG1 list is untouched by coding and unread by billing. *Rejected:* a `feed`/`coder` partition of the encounter
   table (two writers on one table, `ClaimContext` learning a `diagnosisSource`, a scrub rule against mixed sources);
   release writing the shared list (a late DG1 changes a released claim's HI); a `claim_diagnoses` snapshot (callers
   of `buildClaim` must say which list the pointers index).
2. **Coder charge identity.** The unique key becomes `(encounter, source, externalId)`; a coder charge's `externalId`
   is `${codeAssignmentId}#${releaseNumber}`, unique even when a re-sequencing re-bills the same assignment row, and
   37 characters for REF*6R. *Rejected:* a synthetic FT1-style id in the shared namespace; `codeAssignmentId` alone;
   updating the charge in place on re-release (changes billed facts under a claim link).
3. **Schema change.** `src/db/migrations.ts` applies numbered `NNNN_name.sql` files above `pragma user_version`, one
   transaction each, with `foreign_keys` off and `foreign_key_check` before commit; the directory is the list. Today's
   `schema.sql` becomes `0001_baseline.sql` minus its two pragmas, which the Store sets before migrating. Its `if not
   exists` makes it a no-op on a v0.1 database, so fresh and old databases take one path. `0002` backfills
   `claim_charges`, rebuilds `charges` (pointers to by-value diagnoses in SQL via `json_each`), adds the new tables.
   *Rejected:* keeping `schema.sql` current beside migrations (two copies of the shape); fresh-database-only.
4. **Replay and redelivery.** Same MSH-10: `processMessage` answers `duplicate`. Same content under a new MSH-10, or
   a retried `error` row: `appendDocumentVersion` compares content with the latest version and writes nothing
   (`unchanged`); a preliminary after a final is `stale`. DFT proposals are keyed by FT1-2 and compared with the last
   `cerner_dft` row for that key, never the line's current row, so a coder's decision survives a redelivery. A CD's
   removal row carries the CD's own FT1-2. `applyCodingFact` is a no-op when the task already reflects the fact. A
   crash inside a handler rolls back with the audit row. *Rejected:* keying documents on MSH-10 (an identical resend
   would re-version the note and reopen a released task).
5. **Task matrix.** One task per encounter (unique `encounter_id`), created by whichever fact comes first. DFT before
   any document: create `awaiting_documentation` with proposals. DFT after release: proposals appended and the task
   annotated; no automatic reopen (lab lines trickle; a person reopens). Document after release, corrected or new:
   reopen and park the claim. Second final document before release: no transition. During QA, any new fact returns the
   task to the coder. A03 with no document: create `awaiting_documentation` with `documentationDueAt`. Preliminary
   documents never raise a fact. *Deviation from SPEC 7.1:* coverage is not a readiness input; a final document alone
   moves to `ready_to_code`, and missing coverage is a coding-edit warning plus a `NoCoverageError` at hand-off.
   *Rejected:* a reconciling sweep that promotes tasks when coverage arrives (a second task-creation path).
6. **Pass-through switch.** `AppConfig.coding.mode` (`BILLING_MODE`, default `coder`), read only in
   `ingest/intake.ts intakeFor`. *Rejected:* branching in each handler and in `buildClaim`; stamping a mode on each
   encounter; a flag in every handler's context.
7. **A03 plus timeout.** No timer and no sweep. In coder mode the A03 creates the task immediately in
   `awaiting_documentation` with `documentationDueAt = dischargeAt + N hours`; overdue is a read filter
   (`GET /coding/tasks?status=awaiting_documentation&overdue=true&asOf=`). The e2e passes `asOf` and never waits.
   *Deviation from SPEC 7.1 wording* ("A03 plus timeout" creates the task): the task exists from the A03 but is in
   no coder's queue until a final document arrives; the lead's overdue list is the timeout. *Rejected:* a sweep on a
   `main.ts` interval plus a route (a scheduler, a crash window, a clock in tests).
8. **Release outcome.** Returns `blocked { violations }`, `qa_review { task }`, or `released { task, releaseNumber,
   charges: { created, voided, kept }, claim: built | not_built }`. Second call: in `qa_review`, returns `qa_review`
   with no writes; in `released`, writes nothing to coding state and re-runs the claim hand-off (the retry path);
   other statuses throw `InvalidTaskTransitionError`. One missing fee blocks the whole release; nothing is written.
   Task transitions and charges commit in one transaction; `buildClaim` runs in its own, and a throw becomes
   `claim: { kind: 'not_built', error }` with the release standing and the charges unbilled. *Rejected:* one
   transaction around both (a coverage gap would undo a coder's finished work); a 409 on the second call (hides the
   crash-between-transactions recovery).

## Synthesis decision

Base: the opus candidate. Cross-judge (opus, outside the parent's family) and orchestrator agreed on it after
disagreeing at first: the orchestrator had fable one rubric point ahead on single ownership and fit, the judge had
opus ahead on replay idempotence, typed write paths and landing correctness. Reading both rationales again settled it
on three verified facts: fable keyed documents on MSH-10 so an identical resend re-versions a note and reopens a
released task; fable and haiku derived `claimed` as "linked to a non-closed claim", which re-bills a paid claim's
charges once it closes; and only opus stripped the WAL pragma from the baseline migration, which SQLite refuses
inside a transaction. Opus also had the pure `reactToFact` matrix, `UNIQUE(supersedes)`, typed Store write paths
(`saveCernerCharge` / `insertCoderCharges` / `voidCharges`) and `listBillableCharges` as the one billing predicate.

Grafted from fable: diagnoses by value on charges with the claim HI derived (replacing opus's `feed`/`coder`
partition of the encounter table, which gave one table two writers and taught `ClaimContext` about charge sources);
`ScrubRule<Ctx>` generic with `rule()`/`when()` exported so coding edits reuse the claim scrubber's helpers;
`draftClaim` so a reopen parks the open claim and a stale `ready` claim cannot be submitted mid-recode. Grafted from
sonnet and fable: a DFT after release annotates rather than reopens. Folded on the judge's shallow-module finding: the
intake's two-call sequence (`recordCernerProposals` then `applyCodingFact`) into one coding verb per fact.

Rejected from the losers: haiku's in-place update of coder charges on re-release (changes billed facts under a claim
link, and its reopen-then-release path left re-released lines voided); haiku's one unreleased task per
`(encounter, specialty)` (every trigger then needs a which-task rule); sonnet's release replacing the encounter
diagnosis list guarded by "any coder charge exists" (two writers behind a derived guard); sonnet's dropping of DFT
lines that arrive after release; fable's one-transaction release (a payer-data gap would roll back a coder's work)
and 409 on repeat; the sweep-plus-timer timeout from fable, sonnet and haiku; haiku's release digest (the
`ReleaseRecord` on the `released` event already carries the full set, and QA re-plans from the log).

Convergence shipped as-is: append-only `code_assignments` with `supersedes` on the new row and `supersededBy`
derived; insert-only `claim_charges` written only by `claims/build.ts`; `Charge.status` derived in SQL; immutable
versioned documents with "superseded" derived; migrations on `user_version` with `schema.sql` frozen as version 1;
one missing fee blocks the whole release; deterministic hash QA sampling; modifiers as a field; `suggest` as an
interface only; one task per encounter; raising a query is the hold and answering it is the resume.

## Tradeoffs accepted

- We accept one task per encounter for the encounter's lifetime, in exchange for idempotent creation (a unique key)
  and one obvious home for every fact. A radiology read and a progress note on the same FIN share a task.
- We accept that a diagnosis no procedure line points to does not appear on the claim's HI, in exchange for the
  claim's content being a pure function of its charges and no pointer invariant surviving in billing.
- We accept a wider M1 diff (837P builder, two scrub rules, `mapFt1`, `upsertCharges`, testkit, charges migration)
  for the same reason.
- We accept that reopening voids only the lines whose billing facts changed at the next release, in exchange for
  stable charge ids and no claim churn when a correction changes nothing. SPEC 7.1 says "voided and rebuilt"; this is
  a refinement, and the claim is parked in draft in the meantime.
- We accept that a missing fee blocks the coder, in exchange for coder charges that are immutable after insert with a
  price fixed at release. The biller fixes the schedule, then the coder releases.
- We accept that QA can only agree or return, in exchange for a code set frozen outside `in_progress`. CodingAudit
  findings ride in the event detail until a table exists.
- We accept that a charge stays `claimed` once linked, even after its claim is denied and closed, in exchange for an
  insert-only link table. "Billable to coverage X" is `listBillableCharges`, which secondary billing will use.
- We accept that `processMessage` takes a required handler table, which touches every test call site, in exchange for
  no caller silently inheriting a billing mode.
- We accept that late Cerner charges after release wait as pending proposals until a person reopens, in exchange for
  released claims not bouncing as lab lines trickle in.

## Alternatives considered

- **Mutable code set with a status column per code** plus a history table. Same edit verbs, but history becomes a
  sync target and "current set" has two sources. Lost on append-only and single source of truth.
- **Price at claim build** (`rescrub` reprices coder charges; a missing fee becomes a claim scrub error). Coders are
  never blocked by billing configuration, but coder charge amounts have two writers and a submitted claim's price
  depends on when rescrub last ran. Lost on one writer per field.
- **Coding as a status on Charge** (`needs_coding` charges edited in place). Every charge reader learns coder states,
  provenance and history do not fit one row, and a DFT line the coder disagrees with has nowhere to go.
- **Void everything and rebuild on reopen.** No diff logic, but every reopen churns charge ids, REF*6R values and
  claim events. The diff is about 40 lines inside `planRelease`, hidden behind `release`.

## Implementation reconciliation

Filled in during Phase D. Each accepted deviation names its unit, what changed, and why the shared contract holds.

- **Unit 1, `0002_m1_coding.sql`: no `voided_at` for v0.1 `status = 'voided'` rows.** The sketch stamped `strftime('now')` into
  `voided_at` for a migrated charge whose old status was `voided`, but every migrated row is `cerner_dft` and the same table's
  `check (voided_at is null or source = 'coder')` would refuse it. v0.1 has no writer of `voided`, so the migration sets
  `voided_at` to null for every row. The contract holds: Cerner charges are not voidable, and the derived status is still the
  view's only definition.
- **Unit 1, `0002_m1_coding.sql`: `code_assignment_id` has no foreign key yet.** `code_assignments` arrives in unit 2, so the
  column is plain nullable text with the sketch's `check ((source = 'coder') = (code_assignment_id is not null))` kept. Unit 2
  adds the reference when it creates the table.
- **Unit 1, by-value conversion:** the `json_each` join carries `order by p.key` so `diagnoses_json` keeps pointer order, and a
  diagnosis with no description is written without a `description` key rather than `null`, so a migrated row reads back in the
  same shape `saveCernerCharge` writes.
- **Unit 1, `claims/testkit.ts`:** adds `addCoderCharge` (a released coder charge with `${codeAssignmentId}#1` as its external
  id) so unit-1 tests can exercise `voidCharges` and the always-rescrub path before the coding module exists.

- **Unit 2, `0002_m1_coding.sql`: extended in place; unshipped.** The documents, coding_tasks, coding_task_events, provider_queries,
  code_assignments and fee_schedule_lines tables, indexes, CHECK constraints and append-only triggers were added to 0002 before the
  charges rebuild, and `charges.code_assignment_id` now carries `references code_assignments(id)` as the sketch had it. No 0003: 0002
  had not shipped. The FK means a coder charge needs its code-log row first, so `claims/testkit.ts addCoderCharge` and the Store tests
  write a decided assignment row before the charge.
- **Unit 2, `codes.ts recordCernerProposals` drops the `messageId` parameter.** The sketch passed it, but no column or row carries it
  (`CodeAssignment` has `sourceRef`, not a message id) and the proposals fact gets the id from `cernerLinesArrived`'s ctx. The contract
  holds: the DFT origin of a task names the message; proposal rows name their FT1-2.
- **Unit 2, FT1-19 diagnoses are proposed from CG lines only.** The sketch's rule reads "FT1-19 code not active and no prior `dx:<code>`
  row"; a CD's FT1-19 names the diagnosis of the charge it retracts, and a credit should not seed a diagnosis the coder then has to
  remove. Tested in `codes.test.ts`.
- **Unit 2, "annotate" on proposals after release is the pending rows plus the ACK summary.** No event row is written: an event without a
  status change would need a second writer of coding_task_events beside `recordTaskTransition`. The pending lines are visible on the
  task and block the next release; the ingest summary says `proposals pending after release; a person reopens`.
- **Unit 2, `config.ts` imports `CodingConfig` through `coding/index.ts`**, not `coding/config.ts` as the sketch did, so the
  `index.test.ts` boundary (nothing outside `src/coding` imports another coding file) holds for config too. `BILLING_MODES` is exported
  for the env validation.
- **Unit 2, `claims/index.ts` exports `OPEN`.** `applyCodingFact` and `reopenTask` park the OPEN claims holding a live coder charge; the
  constant was module-private in `build.ts`. One definition of "open" instead of a copy in coding.
- **Unit 2, `api/router.ts` exports `oneOf` and `STATUS_BY_ERROR_NAME`.** `coding-routes.ts` narrows enums with the same helper as
  `routes.ts`, and `router.test.ts` reads the table to prove every exported error class of claims and coding has a row.
- **Unit 2, `parseCodeEdits` returns `CodeEdit[]`**, not `unknown`: the route is the boundary, so the narrowed type is what the coding
  module receives. It reads `body.edits` (the sketch's doc said it takes the array) so the route passes the body once.
- **Unit 2, `workbench.ts`: `CodingContext` has no `plan` yet and `CodesView.violations` is `[]`.** `plan.ts` and `edits.ts` are unit 3;
  `readCodes` and `editCodes` return the lines with an empty violations array until the rules exist. `summarizeDocuments` is exported
  (routes and the encounter detail use it) and `loadCodingContext` is exported for unit 3's release.
- **Unit 2, `documentAppended` marks a correction** when the document status is `corrected` or when a new version replaces a
  non-preliminary one; a final after a preliminary is not a correction. Both reopen a released task; only the event reason differs.

- **Unit 3, `types.ts` gains `ChargeDelta` and `ReleaseRecord`**, which the sketch's types file had but unit 2 never landed, plus an
  optional `ReleaseRecord.qaNotes`. QA's notes on an agree had nowhere to go (the sketch said "QA findings ride in the event detail") and the
  reviewer is already the event's actor, so the record carries the notes instead of a second detail shape. The contract holds: the `released`
  event's detail is one `ReleaseRecord`.
- **Unit 3, `PlannedLine` carries `procedure: ProcedureCode` and `chargesToCreate(plan, encounterId, releaseNumber, newId)`.** The sketch's
  `chargesToCreate(plan, input, ...)` needed the `PlanInput` again only to look the procedure content up by assignment id, and `CodingContext`
  holds the plan, not the input. With the content on the line the plan is self-describing: what the edits check is literally what is written.
  `PlanInput` therefore has no `encounterId`.
- **Unit 3, `readCodes`, `editCodes` and `loadTaskView` take `billing: BillingProviderConfig`.** `ScrubRule.check(ctx, cfg)` is the shared
  shape, so `runCodingEdits` needs a `cfg` even though no M1 coding rule reads it, and the workbench calls it on every read. The routes pass
  `config.billing`; `addCodingRoutes` takes `{ store, config }` as the sketch's own signature had it. The alternative, a rule shape without
  `cfg` for coding, would have forked the shape the design grafted for sharing.
- **Unit 3, `claims/index.ts` exports `hasErrors`.** Release gates on the same predicate the claim builder uses; one definition.
- **Unit 3, `release` on a `released` task answers with the count of `released` events as its release number** and `kept` = the encounter's
  live coder charges; the sketch's phrase "returns the last ReleaseRecord's delta" is read as the release number, since the created and voided
  lists are empty by definition on a repeat and the count is the number the last record carries.
- **Unit 3, the keep rule compares diagnoses by `(sequence, code)`** and ignores `description`. The description never reaches the 837P, so
  a relabelled diagnosis does not re-bill a line; a re-sequencing does.
- **Unit 3, `billed-claim-locked` fires only for charges the plan voids.** A kept line on a submitted claim is not a change, and a new line
  beside a submitted claim opens a new claim through `listBillableCharges`, which is the secondary-billing predicate working as designed.
- **Unit 3, the e2e's `change` to 99214 keeps the proposal's modifiers 25 and 95**, so the fee lookup exercises the base-line fallback
  (`SV1*HC:99214:25:95*180.00`), and the manual remittance posts `{ 18000, 13000, 2000, CO-45 3000 }` to a zero balance, which is `paid`.

## Open questions and risks

- Should an encounter with both a progress note and a radiology read get two tasks keyed by specialty? Yes changes the
  unique key to `(encounter, specialty)` and gives the A03 and DFT facts a specialty to name.
- Is coverage-free readiness acceptable to Harpreet's team, or must `ready_to_code` wait for coverage (decision 5
  deviation)? Making it wait needs a coverage fact from `ingestDemographics`.
- Is "task exists from the A03, overdue is a filter" acceptable as the reading of "A03 plus timeout" (decision 7)?
- Is dropping diagnoses no line points to from the HI acceptable to the billing lead? If not, a claim-level snapshot
  returns and with it the pointer rules.
- After a submitted claim exists, release refuses changes (`billed-claim-locked`) until corrected claims (frequency
  code 7, M4) arrive. Is a reopened task stuck in `in_progress` acceptable until then?
- Can a coder release "nothing billable"? `procedure-present` is an error, so a task cannot void all its charges.
- Do Cerner's T08 and T10 carry the full note or only the change? The mapper assumes full content.
- Risk: the `0002` rebuild of `charges` relies on `foreign_keys = off` outside the transaction; `migrate` must set
  it before `begin`. A test opens a v0.1-shaped file with a claimed, pointer-bearing charge and checks the backfilled
  link and the by-value conversion.

## Next implementation step

Land `migrations.ts` with `0001_baseline.sql` and `0002_m1_coding.sql`, plus the Store changes for charges
(source union, by-value diagnoses, derived status), `claim_charges` and `listBillableCharges`, and migrate
`buildClaim`, `loadClaimContext`, the 837P HI/SV1 builder, the scrub rules, routes, `upsertCharges` and the testkit.
No coding module yet, so `npm run check` and today's e2e prove the link-table and by-value swap on their own.
