// Process-level coding configuration. Tenancy (M3) moves it per tenant; until then one
// value for the whole process, read from the environment by src/config.ts.

/**
 * `coder`: nothing reaches a claim without a CodingTask release (SPEC 6).
 * `pass_through`: v0.1 behaviour; DFT lines become charges, documents are stored, no tasks.
 * Read in exactly one place: ingest/intake.ts intakeFor().
 */
export type BillingMode = 'coder' | 'pass_through';

export const BILLING_MODES: readonly BillingMode[] = ['coder', 'pass_through'];

export interface CodingConfig {
  mode: BillingMode;
  /** N in "A03 plus N hours": how long a task may wait for a final document before it is overdue. */
  documentationGraceHours: number;
  /** 0..100. Share of releases routed to qa_review. 100 is "all". Deterministic per (task, release number). */
  qaSamplePercent: number;
}
