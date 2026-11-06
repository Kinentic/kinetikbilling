import { comp, firstSegment, parseHl7DateTime } from '../../hl7/index.ts';
import type { MessageHandler } from '../handler.ts';
import { ingestDemographics } from './demographics.ts';

/** ADT^A03: demographics, with EVN-6 (event occurred) then EVN-2 (recorded) standing in for an empty PV1-45. */
export const discharge: MessageHandler = (store, msg, now) => {
  const evn = firstSegment(msg, 'EVN');
  const fallback = evn && (parseHl7DateTime(comp(evn, 6)) ?? parseHl7DateTime(comp(evn, 2)));
  return { summary: ingestDemographics(store, msg, now, fallback).parts.join(', ') };
};
