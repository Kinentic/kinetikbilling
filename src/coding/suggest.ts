// SPEC 7.5 slot. Interface only; no implementation, table, or route in M1.
// A suggestion never creates a Charge: accepted codes enter the log through
// CodeEdit 'add' with provenance 'ai_suggestion', and only release creates charges.

import type { CodeContent, CodingTask, Document, DocumentId, IsoDateTime } from '../domain/types.ts';

export interface TextSpan {
  documentId: DocumentId;
  /** UTF-16 offsets into Document.body. */
  start: number;
  end: number;
}

export interface SuggestedCode {
  content: CodeContent;
  spans: readonly TextSpan[];
  /** 0..1. */
  confidence: number;
}

export interface AiSuggestion {
  taskId: CodingTask['id'];
  documentIds: readonly DocumentId[];
  model: { name: string; version: string };
  proposals: readonly SuggestedCode[];
  createdAt: IsoDateTime;
}

/** Async because the M8 implementation calls a model; nothing in M1 awaits it. */
export type Suggest = (task: CodingTask, documents: readonly Document[]) => Promise<AiSuggestion>;
