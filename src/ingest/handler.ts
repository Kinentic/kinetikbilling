import type { Store } from '../db/store.ts';
import type { IsoDateTime, MessageId } from '../domain/types.ts';
import type { Hl7Message } from '../hl7/index.ts';

export interface HandlerResult { summary: string }

export interface HandlerContext {
  now: IsoDateTime;
  /** The audit row id: the prior row's id on a sender retry of an `error` message, else fresh. A Document cites it. */
  messageId: MessageId;
}

export type MessageHandler = (store: Store, msg: Hl7Message, ctx: HandlerContext) => HandlerResult;

/** `${MSH-9.1}^${MSH-9.2}` to its handler. Built per billing mode by registry.ts handlersFor. */
export type HandlerTable = Readonly<Record<string, MessageHandler>>;

/** A required value is missing or contradictory. The message is stored as `error` and answered with AE. */
export class IngestError extends Error {
  override readonly name = 'IngestError';
}
