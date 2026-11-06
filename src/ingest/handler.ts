import type { Store } from '../db/store.ts';
import type { IsoDateTime } from '../domain/types.ts';
import type { Hl7Message } from '../hl7/index.ts';

export interface HandlerResult { summary: string }

export type MessageHandler = (store: Store, msg: Hl7Message, now: IsoDateTime) => HandlerResult;

/** A required value is missing or contradictory. The message is stored as `error` and answered with AE. */
export class IngestError extends Error {
  override readonly name = 'IngestError';
}
