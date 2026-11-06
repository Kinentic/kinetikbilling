// Public surface of coding. Routes, ingest and config import from here only. The record*
// functions, applyCodingFact, the release plan functions, enterReleased, handOff and
// sampled are not re-exported; coding/index.test.ts asserts nothing outside src/coding
// imports a coding file other than index.ts.

export { TASK_TRANSITIONS, TaskNotFoundError, InvalidTaskTransitionError, canTransitionTask, requireTask } from './state.ts';
export {
  reactToFact, documentAppended, cernerLinesArrived, visitCompleted, assignTask, startTask, reopenTask, addHours, TaskAssignedElsewhereError,
  type CodingFact, type TaskReaction,
} from './tasks.ts';
export { deriveCodeSet, activeCodes, StaleCodeLineError, CodeLineNotFoundError, type CodeEdit, type CernerLine, type CodeSet, type CodeLine } from './codes.ts';
export {
  readCodes, editCodes, loadTaskView, loadCodingContext, summarizeDocuments, TaskNotEditableError,
  type TaskView, type CodesView, type CodingContext, type DocumentSummary,
} from './workbench.ts';
export { unitFee, replaceFeeSchedule, FeeScheduleError } from './fees.ts';
export type { ReleasePlan, PlannedLine, LiveCharge } from './plan.ts';
export { CODING_RULES, runCodingEdits, type CodingRule } from './edits.ts';
export { release, reviewQa, type ReleaseDeps, type ReleaseInput, type ReleaseOutcome, type ClaimHandoff, type QaDecision } from './release.ts';
export { raiseQuery, answerQuery, QueryNotFoundError, QueryAlreadyAnsweredError, type RaiseQueryInput } from './queries.ts';
export { BILLING_MODES, type CodingConfig, type BillingMode } from './config.ts';
export type { Suggest, AiSuggestion } from './suggest.ts';
