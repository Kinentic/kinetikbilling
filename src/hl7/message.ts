// Parsed HL7 v2 message. Pure data: the parser produces it, ingest reads it.
// Strings are already unescaped (\F\ \S\ \T\ \R\ \E\ resolved).
//
// Hierarchy follows the standard: a message is segments, a segment is fields,
// a field repeats, a repetition is components, a component is subcomponents.
// Indices in the accessor functions are HL7's 1-based numbering, so
// comp(pid, 5, 1) is PID-5.1, the family name.

export interface Hl7Encoding {
  field: string;        // default |
  component: string;    // default ^
  repetition: string;   // default ~
  escape: string;       // default \
  subcomponent: string; // default &
}

export const DEFAULT_ENCODING: Hl7Encoding = {
  field: '|',
  component: '^',
  repetition: '~',
  escape: '\\',
  subcomponent: '&',
};

/** Subcomponents of one component. */
export type Hl7Component = readonly string[];
/** Components of one repetition. */
export type Hl7Repetition = readonly Hl7Component[];
/** Repetitions of one field. Always at least one (possibly empty) repetition. */
export type Hl7Field = readonly Hl7Repetition[];

export interface Hl7Segment {
  readonly name: string;
  /** fields[0] is field 1. For MSH, field 1 is the field separator and field 2 the encoding characters. */
  readonly fields: readonly Hl7Field[];
}

export interface Hl7Header {
  sendingApplication: string;
  sendingFacility: string;
  receivingApplication: string;
  receivingFacility: string;
  /** MSH-7 as sent, e.g. 20261105143000-0800. */
  timestamp: string;
  messageType: string;  // MSH-9.1, e.g. ADT
  triggerEvent: string; // MSH-9.2, e.g. A04
  controlId: string;    // MSH-10
  processingId: string; // MSH-11
  version: string;      // MSH-12
}

export interface Hl7Message {
  readonly encoding: Hl7Encoding;
  readonly header: Hl7Header;
  readonly segments: readonly Hl7Segment[];
}

export class Hl7ParseError extends Error {
  override readonly name = 'Hl7ParseError';
}

export type AckCode = 'AA' | 'AE' | 'AR';
