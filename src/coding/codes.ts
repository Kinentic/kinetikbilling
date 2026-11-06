// The code log: the only writer of code_assignments, and the only place that knows how
// the current code set is derived from it. Everything except the two record* functions
// is pure.

import type { Store } from '../db/store.ts';
import { newId } from '../domain/ids.ts';
import type {
  CodeAssignment, CodeAssignmentId, CodeContent, CodeLineId, DiagnosisCode, EncounterId, IsoDateTime, ProcedureCode, ProviderQueryId,
} from '../domain/types.ts';

export interface CodeLine {
  lineId: CodeLineId;
  /** The row no other row supersedes. */
  current: CodeAssignment;
  /** Oldest first; history[i] is superseded by history[i+1] (derived, never stored). */
  history: readonly CodeAssignment[];
  /** current has no decision: a proposal (cerner_dft, ai_suggestion) the coder has not ruled on. */
  pending: boolean;
}

export interface CodeSet {
  /** Every line, including removed ones (the coder sees what was removed and by whom). */
  lines: readonly CodeLine[];
}

/** Lines whose current row is decided and not removed, by kind; diagnoses in sequence order. */
export interface ActiveCodes {
  procedures: readonly { lineId: CodeLineId; assignmentId: CodeAssignmentId; code: ProcedureCode }[];
  diagnoses: readonly { lineId: CodeLineId; assignmentId: CodeAssignmentId; code: DiagnosisCode }[];
}

const toLine = (history: CodeAssignment[]): CodeLine => {
  const current = history[history.length - 1]!;
  return { lineId: current.lineId, current, history, pending: current.decision === undefined };
};

/**
 * Folds the log (seq order) into lines. Invariants it may assume because SQL enforces
 * them: ids unique, `supersedes` unique, a superseded row precedes its successor.
 */
export function deriveCodeSet(rows: readonly CodeAssignment[]): CodeSet {
  const byLine = new Map<CodeLineId, CodeAssignment[]>();
  for (const row of rows) {
    const history = byLine.get(row.lineId);
    if (history) history.push(row);
    else byLine.set(row.lineId, [row]);
  }
  return { lines: [...byLine.values()].map(toLine) };
}

export function activeCodes(set: CodeSet): ActiveCodes {
  const live = set.lines.filter((l) => !l.pending && !l.current.removed);
  const pick = <K extends CodeContent['kind']>(kind: K) => live
    .filter((l) => l.current.content.kind === kind)
    .map((l) => ({ lineId: l.lineId, assignmentId: l.current.id, code: l.current.content as Extract<CodeContent, { kind: K }> }));
  return {
    procedures: pick('procedure'),
    diagnoses: pick('diagnosis').sort((a, b) => a.code.sequence - b.code.sequence),
  };
}

/** Codes upper-cased, modifiers trimmed, diagnosisCodes de-duplicated, so equal content compares equal. */
export const normalizeContent = (content: CodeContent): CodeContent => {
  if (content.kind === 'diagnosis') return { ...content, code: content.code.trim().toUpperCase() };
  const modifiers = content.modifiers.map((m) => m.trim().toUpperCase()).filter((m) => m !== '');
  const diagnosisCodes = [...new Set(content.diagnosisCodes.map((c) => c.trim().toUpperCase()).filter((c) => c !== ''))];
  return { ...content, code: content.code.trim().toUpperCase(), modifiers, diagnosisCodes };
};

const stable = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => (
  x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).filter(([, y]) => y !== undefined).sort()) : x));
export const sameContent = (a: CodeContent, b: CodeContent): boolean => stable(normalizeContent(a)) === stable(normalizeContent(b));

/** A running view of the set that a batch of edits or proposals extends row by row. */
class RunningSet {
  readonly #lines: Map<CodeLineId, CodeLine>;
  readonly appended: CodeAssignment[] = [];
  constructor(set: CodeSet) {
    this.#lines = new Map(set.lines.map((l) => [l.lineId, l]));
  }
  line(lineId: CodeLineId): CodeLine | undefined { return this.#lines.get(lineId); }
  lines(): CodeLine[] { return [...this.#lines.values()]; }
  append(row: CodeAssignment): CodeAssignment {
    const prior = this.#lines.get(row.lineId);
    this.#lines.set(row.lineId, toLine(prior ? [...prior.history, row] : [row]));
    this.appended.push(row);
    return row;
  }
}

// Coder edits -------------------------------------------------------------------------

/**
 * What the workbench sends. `basedOn` is the row the coder was looking at; a stale view
 * is refused (StaleCodeLineError) instead of silently overwriting a newer decision.
 * Rejecting a proposal is `remove` (an added line) or `change` (a proposed removal).
 */
export type CodeEdit =
  | { op: 'add'; content: CodeContent; queryId?: ProviderQueryId }
  | { op: 'change'; lineId: CodeLineId; basedOn: CodeAssignmentId; content: CodeContent }
  | { op: 'remove'; lineId: CodeLineId; basedOn: CodeAssignmentId }
  | { op: 'accept'; lineId: CodeLineId; basedOn: CodeAssignmentId };

export class StaleCodeLineError extends Error {
  constructor(lineId: CodeLineId, basedOn: CodeAssignmentId, current: CodeAssignmentId) {
    super(`code line ${lineId}: edit based on ${basedOn} but current row is ${current}`);
    this.name = 'StaleCodeLineError';
  }
}

export class CodeLineNotFoundError extends Error {
  constructor(lineId: CodeLineId) {
    super(`code line not found: ${lineId}`);
    this.name = 'CodeLineNotFoundError';
  }
}

const basedOnCurrent = (set: RunningSet, lineId: CodeLineId, basedOn: CodeAssignmentId): CodeAssignment => {
  const line = set.line(lineId);
  if (!line) throw new CodeLineNotFoundError(lineId);
  if (line.current.id !== basedOn) throw new StaleCodeLineError(lineId, basedOn, line.current.id);
  return line.current;
};

/**
 * Pure: the rows a batch of edits appends, applied in order against a running set.
 *  add    -> new line, provenance provider_query when queryId is given else coder, decided.
 *  change -> supersedes current, provenance coder, decided.
 *  remove -> supersedes current with removed: true and the same content, provenance coder, decided.
 *  accept -> supersedes current with identical content and removed flag, provenance and
 *            sourceRef kept (cerner_dft stays cerner_dft: acceptance rate is a join), decided.
 *            Accepting an already-decided row appends nothing.
 */
export function planCoderEdits(set: CodeSet, encounterId: EncounterId, coder: string, edits: readonly CodeEdit[], at: IsoDateTime): CodeAssignment[] {
  const running = new RunningSet(set);
  const decision = (queryId?: ProviderQueryId) => ({ by: coder, at, ...(queryId ? { queryId } : {}) });
  for (const edit of edits) {
    switch (edit.op) {
      case 'add':
        running.append({
          id: newId<CodeAssignmentId>(), encounterId, lineId: newId<CodeLineId>(), content: normalizeContent(edit.content), removed: false,
          provenance: edit.queryId ? 'provider_query' : 'coder', decision: decision(edit.queryId), recordedAt: at,
        });
        break;
      case 'change':
      case 'remove': {
        const current = basedOnCurrent(running, edit.lineId, edit.basedOn);
        running.append({
          id: newId<CodeAssignmentId>(), encounterId, lineId: edit.lineId, supersedes: current.id,
          content: edit.op === 'change' ? normalizeContent(edit.content) : current.content, removed: edit.op === 'remove',
          provenance: 'coder', decision: decision(), recordedAt: at,
        });
        break;
      }
      case 'accept': {
        const current = basedOnCurrent(running, edit.lineId, edit.basedOn);
        if (current.decision) break;
        running.append({
          id: newId<CodeAssignmentId>(), encounterId, lineId: edit.lineId, supersedes: current.id, content: current.content, removed: current.removed,
          provenance: current.provenance, ...(current.sourceRef ? { sourceRef: current.sourceRef } : {}), decision: decision(), recordedAt: at,
        });
        break;
      }
    }
  }
  return running.appended;
}

/** Appends planCoderEdits' rows. Callers (workbench.editCodes) check the task is in_progress. */
export function recordCoderEdits(store: Store, encounterId: EncounterId, coder: string, edits: readonly CodeEdit[], at: IsoDateTime): CodeSet {
  return store.transaction(() => {
    const rows = store.listCodeAssignments(encounterId);
    const appended = planCoderEdits(deriveCodeSet(rows), encounterId, coder, edits, at);
    store.appendCodeAssignments(appended);
    return deriveCodeSet([...rows, ...appended]);
  });
}

// Cerner proposals (DFT^P03 in coder mode) --------------------------------------------

/** An FT1 line as the coding module needs it. ingest/intake.ts converts MappedCharge to this. */
export interface CernerLine {
  /** FT1-2. */
  sourceRef: string;
  /** FT1-6 = CD. */
  reversal: boolean;
  procedure: ProcedureCode;
  /** FT1-19, in order. */
  diagnoses: readonly { code: string; description?: string }[];
}

export interface ProposalOutcome {
  appended: number;
  unchanged: number;
  /** CD lines with no matching CG line on the encounter: reported in the ACK summary, not stored as rows. */
  unmatchedCredits: string[];
}

const DX_REF = 'dx:';

const sameModifiers = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join(':') === [...b].sort().join(':');

/**
 * Pure. Replay key is sourceRef; comparison is against the last cerner_dft row carrying
 * that sourceRef, never against the line's current row, so a coder's change survives a
 * redelivery of the same FT1.
 *
 *  CG, sourceRef unseen                 -> new line, pending proposal.
 *  CG, last cerner row has same content -> nothing (replay, redelivery under a new MSH-10).
 *  CG, content differs                  -> pending proposal row superseding the line's current row
 *                                          (Cerner corrected the charge; the coder must re-decide).
 *  CD, sourceRef unseen                 -> pending removal row on the CG line with the same code,
 *                                          modifiers and service date whose current row is not removed;
 *                                          sourceRef = the CD's FT1-2. No match: unmatchedCredits.
 *  CD, sourceRef seen                   -> nothing.
 *  FT1-19 code of a CG line, not active and with no prior `dx:<code>` row -> pending diagnosis proposal, next sequence.
 */
export function planCernerProposals(set: CodeSet, rows: readonly CodeAssignment[], encounterId: EncounterId, lines: readonly CernerLine[], at: IsoDateTime): { rows: CodeAssignment[]; unmatchedCredits: string[] } {
  const running = new RunningSet(set);
  const lastCerner = new Map<string, CodeAssignment>();
  for (const row of rows) if (row.provenance === 'cerner_dft' && row.sourceRef !== undefined) lastCerner.set(row.sourceRef, row);
  const propose = (row: Omit<CodeAssignment, 'id' | 'encounterId' | 'provenance' | 'recordedAt'> & { sourceRef: string }): void => {
    lastCerner.set(row.sourceRef, running.append({ id: newId<CodeAssignmentId>(), encounterId, provenance: 'cerner_dft', recordedAt: at, ...row }));
  };
  const unmatchedCredits: string[] = [];

  for (const line of lines) {
    const content = normalizeContent(line.procedure) as ProcedureCode;
    const last = lastCerner.get(line.sourceRef);
    if (line.reversal) {
      if (last) continue;
      const target = running.lines().find((l) => l.current.content.kind === 'procedure' && !l.current.removed
        && l.current.content.code === content.code && sameModifiers(l.current.content.modifiers, content.modifiers) && l.current.content.serviceDate === content.serviceDate);
      if (!target) { unmatchedCredits.push(line.sourceRef); continue; }
      propose({ lineId: target.lineId, supersedes: target.current.id, content: target.current.content, removed: true, sourceRef: line.sourceRef });
      continue;
    }
    if (!last) {
      propose({ lineId: newId<CodeLineId>(), content, removed: false, sourceRef: line.sourceRef });
    } else if (!sameContent(last.content, content)) {
      const current = running.line(last.lineId)!.current;
      propose({ lineId: last.lineId, supersedes: current.id, content, removed: false, sourceRef: line.sourceRef });
    }
    for (const dx of line.diagnoses) {
      const code = dx.code.trim().toUpperCase();
      if (code === '' || lastCerner.has(`${DX_REF}${code}`)) continue;
      const diagnoses = running.lines().filter((l) => l.current.content.kind === 'diagnosis');
      if (diagnoses.some((l) => !l.current.removed && (l.current.content as DiagnosisCode).code === code)) continue;
      const sequence = Math.max(0, ...diagnoses.map((l) => (l.current.content as DiagnosisCode).sequence)) + 1;
      propose({
        lineId: newId<CodeLineId>(), removed: false, sourceRef: `${DX_REF}${code}`,
        content: { kind: 'diagnosis', code, sequence, ...(dx.description ? { description: dx.description } : {}) },
      });
    }
  }
  return { rows: running.appended, unmatchedCredits };
}

/** Appends planCernerProposals' rows. Called only by tasks.ts cernerLinesArrived, inside the DFT handler's transaction. */
export function recordCernerProposals(store: Store, encounterId: EncounterId, lines: readonly CernerLine[], at: IsoDateTime): ProposalOutcome {
  return store.transaction(() => {
    const rows = store.listCodeAssignments(encounterId);
    const planned = planCernerProposals(deriveCodeSet(rows), rows, encounterId, lines, at);
    store.appendCodeAssignments(planned.rows);
    const touched = new Set(planned.rows.map((r) => r.sourceRef));
    const unchanged = lines.filter((l) => !touched.has(l.sourceRef) && !planned.unmatchedCredits.includes(l.sourceRef)).length;
    return { appended: planned.rows.length, unchanged, unmatchedCredits: planned.unmatchedCredits };
  });
}
