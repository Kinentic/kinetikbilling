import type { Hl7Field, Hl7Message, Hl7Repetition, Hl7Segment } from './message.ts';

const unimplemented = (): never => { throw new Error('hl7/parse not implemented'); };

/** Parse a raw HL7 v2 message (segments separated by \r, \n or \r\n). Throws Hl7ParseError. */
export function parseHl7(_raw: string): Hl7Message { return unimplemented(); }
/** All segments with this name, in document order. */
export function segments(_msg: Hl7Message, _name: string): Hl7Segment[] { return unimplemented(); }
/** First segment with this name, or undefined. */
export function firstSegment(_msg: Hl7Message, _name: string): Hl7Segment | undefined { return unimplemented(); }
/** Field n (1-based). Absent fields return a single empty repetition, never undefined. */
export function field(_seg: Hl7Segment, _n: number): Hl7Field { return unimplemented(); }
/** Repetitions of field n. Empty field yields []. */
export function reps(_seg: Hl7Segment, _n: number): Hl7Repetition[] { return unimplemented(); }
/** Component c / subcomponent s of the first repetition of field n. '' when absent. */
export function comp(_seg: Hl7Segment, _n: number, _c?: number, _s?: number): string { return unimplemented(); }
/** Component c / subcomponent s of one repetition. '' when absent. */
export function repComp(_rep: Hl7Repetition, _c: number, _s?: number): string { return unimplemented(); }
