import type { MessageHandler } from './handler.ts';
import { charges } from './handlers/charges.ts';
import { demographics } from './handlers/demographics.ts';
import { discharge } from './handlers/discharge.ts';
import { merge } from './handlers/merge.ts';

/** `${MSH-9.1}^${MSH-9.2}` to its handler. A type absent here is stored as unsupported. */
export const HANDLERS: Readonly<Record<string, MessageHandler>> = {
  'ADT^A01': demographics,
  'ADT^A04': demographics,
  'ADT^A08': demographics,
  'ADT^A28': demographics,
  'ADT^A31': demographics,
  'BAR^P01': demographics,
  'BAR^P05': demographics,
  'ADT^A03': discharge,
  'ADT^A40': merge,
  'DFT^P03': charges,
};
