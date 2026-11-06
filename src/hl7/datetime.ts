import type { IsoDate, IsoDateTime } from '../domain/types.ts';

const unimplemented = (): never => { throw new Error('hl7/datetime not implemented'); };

/** HL7 TS/DTM (YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ]) to ISO 8601. Undefined for '' or unparseable. */
export function parseHl7DateTime(_ts: string): IsoDateTime | undefined { return unimplemented(); }
/** First 8 digits of an HL7 TS/DT to YYYY-MM-DD. Undefined for '' or unparseable. */
export function parseHl7Date(_ts: string): IsoDate | undefined { return unimplemented(); }
/** Date to HL7 DTM with offset, e.g. 20261105143000-0800. */
export function formatHl7DateTime(_d: Date): string { return unimplemented(); }
