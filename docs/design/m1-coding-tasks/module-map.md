# M1 module map (synthesized)

## New files

| File | Responsibility |
|---|---|
| `src/db/migrations.ts` | `loadMigrations` (numbered files from the directory, contiguity checked) and `migrate` (above `user_version`, one tx each, FK check) |
| `src/db/migrations/0001_baseline.sql` | Today's `schema.sql` minus its two pragmas, moved; no-op on existing v0.1 databases |
| `src/db/migrations/0002_m1_coding.sql` | documents, coding_tasks(+events), provider_queries, code_assignments, fee_schedule_lines, claim_charges (backfilled); rebuilt charges with by-value diagnoses; `charge_states` view; immutability triggers |
| `src/db/migrations.test.ts` | v0.1-shaped DB with a claimed, pointer-bearing charge migrates; link backfilled; pointers converted; second open is a no-op |
| `src/coding/config.ts` | `BillingMode`, `CodingConfig` |
| `src/coding/state.ts` | `TASK_TRANSITIONS`, `transitionTask` (only status writer), `openTask`, task errors; mirrors `claims/state.ts` |
| `src/coding/tasks.ts` | `reactToFact` (pure matrix), module-private `applyCodingFact`, ingest verbs `documentAppended` / `cernerLinesArrived` / `visitCompleted`, `assignTask`, `startTask`, `reopenTask` (parks open claims via `draftClaim`), `addHours` |
| `src/coding/codes.ts` | Code log: `deriveCodeSet`, `activeCodes`, `planCoderEdits`/`recordCoderEdits`, `planCernerProposals`/`recordCernerProposals`; only writer of `code_assignments` |
| `src/coding/fees.ts` | `unitFee` (exact modifiers, then base; effective dates), `replaceFeeSchedule` (validated) |
| `src/coding/plan.ts` | `planRelease` (pure: active diagnoses 1..n, priced lines with by-value diagnoses, rendering default, keep/void diff), `chargesToCreate` |
| `src/coding/workbench.ts` | `CodingContext`/`loadCodingContext`, `readCodes`, `editCodes` (in_progress only), `loadTaskView` |
| `src/coding/edits.ts` | `CODING_RULES` as `ScrubRule<CodingContext>[]` over the plan, `runCodingEdits` |
| `src/coding/release.ts` | `release`, `reviewQa`; private `enterReleased` (writes plan in tx), `handOff` (buildClaim after commit), `sampled` |
| `src/coding/queries.ts` | `raiseQuery` (= hold), `answerQuery` (= resume) |
| `src/coding/suggest.ts` | `Suggest`, `AiSuggestion`, `SuggestedCode`, `TextSpan`: interface only (M8) |
| `src/coding/index.ts` | Public surface of coding; `index.test.ts` asserts no outside import of other coding files |
| `src/coding/*.test.ts` | `tasks.test.ts` (matrix as a table, reopen parks the claim), `codes.test.ts` (derivation, proposals replay), `plan.test.ts` (pricing, keep/void, by-value diagnoses), `release.test.ts` (outcome contract), `queries.test.ts`, `fees.test.ts` |
| `src/ingest/intake.ts` | `CodingIntake`, `intakeFor` (the only reader of the billing mode), `toCernerLines` |
| `src/ingest/handlers/documents.ts` | MDM T02/T04/T08/T10 and ORU R01 handler factory: demographics, `appendDocumentVersion`, intake |
| `src/ingest/map/document.ts` | Pure `mapMdm`, `mapOru`, `obxBody` to `MappedDocument[]` |
| `src/api/coding-routes.ts` | `/documents`, `/coding/tasks...`, `/coding/queries/:id/answer`, `/fee-schedule`; `parseCodeEdits` |
| `fixtures/hl7/mdm-t02-progress-note.hl7`, `mdm-t08-corrected-note.hl7`, `oru-r01-radiology-preliminary.hl7`, `oru-r01-radiology-final.hl7` | M1 fixtures |

## Changed files

| File | Change |
|---|---|
| `src/domain/types.ts` | New ids; Document, CodingTask(+Event), CodeAssignment, CodeContent, ProviderQuery, FeeScheduleLine, ReleaseRecord, ChargeDelta, ClaimCharge, ChargeDiagnosis, ClaimDiagnosis; `Charge` becomes a source union without `status`/`claimId`, with `diagnoses` by value; `ChargeState` derived; `ScrubViolation.lineId` |
| `src/db/schema.sql` | Deleted (moved to `migrations/0001_baseline.sql`) |
| `src/db/store.ts` | Sets pragmas then runs migrations; new sections for documents, tasks, code log, queries, fee schedule, claim_charges; charges split into `saveCernerCharge` / `insertCoderCharges` / `voidCharges` / `listBillableCharges`; `listCharges` reads `charge_states`; diagnoses section unchanged |
| `src/ingest/handler.ts` | `HandlerContext { now, messageId }`; `HandlerTable` |
| `src/ingest/registry.ts` | `HANDLERS` constant becomes `handlersFor(coding)`; adds MDM and ORU |
| `src/ingest/process.ts` | `processMessage(store, raw, handlers, now?)`; passes `{ now, messageId }` |
| `src/ingest/upsert.ts` | `upsertCharges` writes `CernerCharge` with by-value diagnoses; adds `appendDocumentVersion` |
| `src/ingest/handlers/charges.ts`, `discharge.ts` | Factories over the intake |
| `src/ingest/handlers/demographics.ts`, `merge.ts` | `now` becomes `ctx.now` (mechanical) |
| `src/ingest/map/ft1.ts` | `MappedCharge` omit-list tracks the new Charge fields; FT1-19 refs unchanged |
| `src/ingest/index.ts` | Exports `handlersFor`, `HandlerTable`, `HandlerContext` in place of `HANDLERS` |
| `src/ingest/process.test.ts` | Calls take a handler table; DFT tests run pass-through; new MDM/ORU/coder-mode DFT tests; the "ORU unsupported" test moves to SIU^S12 |
| `src/claims/build.ts` | `listBillableCharges` + `attachCharges`; always rescrubs an existing open claim; adds `draftClaim` |
| `src/claims/context.ts` | Charges via the link; `diagnoses` derived by `claimDiagnoses`; `pointersFor` |
| `src/claims/scrub.ts` | `ScrubRule<Ctx>`, exported `rule`/`when`/`ICD10`; pointer-dangling rule removed; two rules read `c.diagnoses`; `claim-dx-count` added |
| `src/claims/edi837p.ts` | HI from the derived list; SV1-7 from `pointersFor` |
| `src/claims/testkit.ts` | `addCharge` seeds a `CernerCharge` with by-value diagnoses (no status); helpers to seed a released coder charge |
| `src/claims/*.test.ts` | Pointer assertions become by-value assertions; `claimId` assertions become `listCharges({ claimId })` |
| `src/api/routes.ts` | Mounts coding routes; `/charges?source=`; claim detail charges via the link; encounter detail adds documents and task |
| `src/api/router.ts` | New `STATUS_BY_ERROR_NAME` rows; test that every exported error name is mapped |
| `src/config.ts` | `AppConfig.coding` from `BILLING_MODE`, `DOCUMENTATION_GRACE_HOURS`, `QA_SAMPLE_PERCENT` |
| `src/main.ts` | `handlersFor(config.coding)` built once, used by MLLP and HTTP ingest |
| `src/hl7/fixtures.test.ts` | Expected type map gains the four new fixtures |
| `scripts/e2e.ts` | Coder-mode flow |
| `README.md` | Coding section, task lifecycle diagram, new routes and env vars; the single-claimId and fee-schedule gaps close |

## Ownership: one writer per piece of state

`documents`: `upsert.appendDocumentVersion`. `coding_tasks.status`: `state.transitionTask`. `coding_tasks.assignee`/`specialty`: `tasks.ts`. `code_assignments`: `codes.ts`. `provider_queries`: `queries.ts`. `fee_schedule_lines`: `fees.replaceFeeSchedule`. `claim_charges`: `claims/build.buildClaim`. Coder charges: `release.enterReleased`. Cerner charges: `upsert.upsertCharges`. Claim status on charge change: `claims/build.ts` (`rescrub`, `draftClaim`). `Charge.status` and the claim HI list: derived.

## Implementation units (each ends with `npm run check` and `npm run e2e` green)

1. **Link table and by-value diagnoses.** Migrations runner, 0001, 0002, Store charge/claim_charges changes, every reader in the grounding table, 837P and scrub, testkit, routes. No coding module; e2e unchanged in flow (DFT still bills: no mode exists yet).
2. **Documents and tasks.** types, store, mappers, `documents` handler, fixtures, `HandlerContext`, `handlersFor`, intake, `CodingConfig`, state, tasks (matrix, ingest verbs), codes (log, proposals), queries, task/codes/queries/documents routes, router rows. e2e gains the task up to `in_progress` with proposals.
3. **Fees, edits, release, QA, reopen.** fees, plan, workbench, edits, release, `draftClaim`, release/qa/fee-schedule routes, e2e to paid claim through correction and re-release, README.
