# Arena brief: design SPEC.md milestone M1

## Artifact each candidate produces

One candidate design package in your own output directory:

1. `design.md` shaped per the architect rationale template (`references/rationale-template.md`), with the usage
   section written first and the type sketch derived from it. Leave "Synthesis decision" and "Implementation
   reconciliation" as headings with one line saying the orchestrator fills them.
2. Sketch files mirroring where they would live in `src/` (for example `sketch/src/domain/types.ts` as a diff or an
   additions block, `sketch/src/coding/tasks.ts`, `sketch/src/ingest/handlers/documents.ts`, `sketch/src/db/schema.sql`
   additions). Types and signatures complete; bodies `throw new Error('not implemented')` or `// TODO` pseudocode; doc
   comments state intent and invariants. A reader must trace MDM in to paid claim out from types and signatures alone.
3. A module map: which files are new, which existing files change, and the one-line responsibility of each.

## Task

Design the smallest coherent set of changes to the v0.1 service that meets SPEC.md section 12 **M1** as its
acceptance criteria define it, grafting the coder-centred model onto the existing shapes described in `grounding.md`.
M1 is done when:

- MDM^T02 and ORU^R01 fixtures ingest into **Documents** (immutable, versioned rows per SPEC 5.2) through the existing
  handler registry, with process tests and fixtures beside them.
- **CodingTasks** are created (first final document; A03 plus timeout as `awaiting_documentation`) and move through
  the SPEC 7.1 lifecycle by API through one `transitionTask` with a transition table and an event row, including
  `on_hold_query` (a minimal **ProviderQuery**), `qa_review` and `returned_to_coder`.
- **CodeAssignment** rows are append-only with provenance (`cerner_dft` | `coder` | `ai_suggestion` |
  `provider_query`) and `supersededBy`; the current code set is derived, never updated in place. A DFT^P03 on an
  encounter in coder mode attaches its FT1 lines as `cerner_dft` proposals rather than billable charges (SPEC 6, last
  row). A process-level **pass-through** switch keeps today's DFT-to-charge behaviour for tenants configured that way.
- **Release** creates charges with `source = 'coder'` priced from a **FeeSchedule** (missing fee is a scrub error),
  records the full code set in the release event, and triggers claim build. Reopening on a corrected document voids
  released charges on an unsubmitted claim and rebuilds.
- **ClaimCharge** link table replaces `charges.claim_id`; `Charge.status` becomes derived; every reader in the
  grounding table is migrated; secondary claims are enabled by the data model but not built.
- API routes from SPEC section 11 for documents, coding tasks, codes, queries and fee schedule, unauthenticated and
  single-tenant like the rest of v0.1.
- `npm run e2e` extends from feed to coded encounter to posted payment.

Also design, as shape only with the smallest rule set that proves the shape: coding-time edits in the `ScrubRule`
form with a coding context (SPEC 7.2), and the `suggest(task, documents) -> AiSuggestion` slot as an interface with no
implementation (SPEC 7.5).

**Out of scope for M1** (do not design, but do not block): tenancy and `tenant_id`, users, roles, AccessLog, OIDC,
Postgres, UI, clearinghouse transport, 999/277CA parsing, SIU appointments, ORM orders, denial worklists, licensed code
set loading, QA sampling policy beyond a single configurable percentage or "all".

## Decisions the design must make explicitly

Each of these appears in the grounding gotchas. State the choice and the alternative you rejected.

1. Where coder-entered ICD-10 codes live relative to the encounter-level `Diagnosis` list and `diagnosisPointers`.
2. Charge identity for coder-sourced charges under the `(encounterId, externalId)` key.
3. How the schema change lands without a migration mechanism.
4. What a replayed or redelivered MDM, ORU or DFT does to Documents, tasks and proposals.
5. The task-creation and DFT-arrival matrix: DFT before any document, DFT after release, document after release,
   second final document, A03 with no document.
6. Where the pass-through switch lives and the one place that reads it.
7. The A03-plus-timeout mechanism and how e2e exercises it without waiting.
8. The outcome contract of `release`: what it returns, what it does on a second call, what happens if the fee lookup
   fails for one line, and what happens if claim build throws after charges are written.

## Rubric (the orchestrator and cross-judge score on these; candidates see them too)

1. **Usage drives types.** README-style usage and two or three real call sites exist and the type sketch agrees with
   them; where they diverged the sketch was reconciled to the usage.
2. **One writer per piece of state.** The charge-to-claim link, task status, current code set, and document version
   each have exactly one writer; `Charge.status` is derived, not synced; no second path to the same outcome.
3. **Fits the existing shapes.** New handlers are `MessageHandler`s in the registry; `Store` stays the only SQL;
   `types.ts` imports nothing; task transitions mirror `claims/state.ts`; new errors have distinct names mapped in
   the router; mappers stay pure; tests and fixtures sit beside their module.
4. **Idempotent under replay and crash.** Every handler and lifecycle operation is stated to be safe to run twice and
   to crash halfway (inside the audit transaction), with the specific cases in decision 4, 5 and 8 answered.
5. **Interface depth.** The public surface (exported functions and routes) is as small as the usage needs and hides
   pricing, pointer resolution, versioning and claim-rebuild behind it; HTTP to store traces in at most three files.
6. **Covers M1 without inventing M2 to M8.** Every acceptance bullet above has a concrete home in the sketch; nothing
   in the out-of-scope list has grown a type or a table "for later" beyond ClaimCharge and the `suggest` interface.
