import { DEFAULT_ENCODING, Hl7ParseError } from './message.ts';
import type { Hl7Component, Hl7Encoding, Hl7Field, Hl7Header, Hl7Message, Hl7Repetition, Hl7Segment } from './message.ts';

const EMPTY_FIELD: Hl7Field = [[['']]];
const SEGMENT_NAME = /^[A-Z][A-Z0-9]{2}$/;

function unescape(text: string, enc: Hl7Encoding): string {
  if (!text.includes(enc.escape)) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== enc.escape) { out += ch; i++; continue; }
    const close = text.indexOf(enc.escape, i + 1);
    if (close === -1) { out += text.slice(i); break; }
    const body = text.slice(i + 1, close);
    const resolved = resolveEscape(body, enc);
    out += resolved ?? text.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

function resolveEscape(body: string, enc: Hl7Encoding): string | undefined {
  switch (body) {
    case 'F': return enc.field;
    case 'S': return enc.component;
    case 'T': return enc.subcomponent;
    case 'R': return enc.repetition;
    case 'E': return enc.escape;
    case '.br': return '\n';
  }
  if (/^X(?:[0-9A-Fa-f]{2})+$/.test(body)) return Buffer.from(body.slice(1), 'hex').toString('utf8');
  return undefined;
}

function parseField(text: string, enc: Hl7Encoding): Hl7Field {
  return text.split(enc.repetition).map((rep): Hl7Repetition =>
    rep.split(enc.component).map((c): Hl7Component =>
      c.split(enc.subcomponent).map((s) => unescape(s, enc))));
}

function parseSegment(line: string, enc: Hl7Encoding): Hl7Segment {
  const name = line.slice(0, 3);
  if (!SEGMENT_NAME.test(name) || (line.length > 3 && line[3] !== enc.field)) {
    throw new Hl7ParseError(`invalid segment: ${JSON.stringify(line.slice(0, 20))}`);
  }
  const parts = line.slice(4).split(enc.field);
  if (name === 'MSH') {
    // MSH-1 and MSH-2 are literal: the separator and the encoding characters.
    const [encodingChars = '', ...rest] = parts;
    return { name, fields: [[[[enc.field]]], [[[encodingChars]]], ...rest.map((p) => parseField(p, enc))] };
  }
  return { name, fields: line.length > 3 ? parts.map((p) => parseField(p, enc)) : [] };
}

/** Parse a raw HL7 v2 message (segments separated by \r, \n or \r\n). Throws Hl7ParseError. */
export function parseHl7(raw: string): Hl7Message {
  const lines = raw.split(/\r\n|\r|\n/).filter((line) => line !== '');
  const first = lines[0];
  if (first === undefined) throw new Hl7ParseError('empty message');
  if (!first.startsWith('MSH')) throw new Hl7ParseError(`first segment must be MSH, got ${JSON.stringify(first.slice(0, 3))}`);
  if (first.length < 8) throw new Hl7ParseError('MSH too short to hold field separator and encoding characters');
  const [component, repetition, escape, subcomponent] = first.slice(4, 8);
  const encoding: Hl7Encoding = {
    ...DEFAULT_ENCODING,
    field: first[3]!,
    component: component ?? DEFAULT_ENCODING.component,
    repetition: repetition ?? DEFAULT_ENCODING.repetition,
    escape: escape ?? DEFAULT_ENCODING.escape,
    subcomponent: subcomponent ?? DEFAULT_ENCODING.subcomponent,
  };
  const segs = lines.map((line) => parseSegment(line, encoding));
  const msh = segs[0]!;
  if (msh.fields.length < 12) {
    throw new Hl7ParseError(`MSH must have at least 12 fields, found ${msh.fields.length}`);
  }
  return { encoding, header: buildHeader(msh), segments: segs };
}

function buildHeader(msh: Hl7Segment): Hl7Header {
  const type = comp(msh, 9, 1);
  let trigger = comp(msh, 9, 2);
  if (trigger === '') {
    const structure = /^[A-Z]{3}_([A-Z][0-9]{2})$/.exec(comp(msh, 9, 3));
    trigger = structure?.[1] ?? '';
  }
  return {
    sendingApplication: comp(msh, 3, 1),
    sendingFacility: comp(msh, 4, 1),
    receivingApplication: comp(msh, 5, 1),
    receivingFacility: comp(msh, 6, 1),
    timestamp: comp(msh, 7, 1),
    messageType: type,
    triggerEvent: trigger,
    controlId: comp(msh, 10, 1),
    processingId: comp(msh, 11, 1),
    version: comp(msh, 12, 1),
  };
}

/** All segments with this name, in document order. */
export function segments(msg: Hl7Message, name: string): Hl7Segment[] {
  return msg.segments.filter((s) => s.name === name);
}
/** First segment with this name, or undefined. */
export function firstSegment(msg: Hl7Message, name: string): Hl7Segment | undefined {
  return msg.segments.find((s) => s.name === name);
}
/** Field n (1-based). Absent fields return a single empty repetition, never undefined. */
export function field(seg: Hl7Segment, n: number): Hl7Field {
  return seg.fields[n - 1] ?? EMPTY_FIELD;
}
/** Repetitions of field n. Empty field yields []. */
export function reps(seg: Hl7Segment, n: number): Hl7Repetition[] {
  const f = field(seg, n);
  const empty = f.every((rep) => rep.every((c) => c.every((s) => s === '')));
  return empty ? [] : [...f];
}
/** Component c / subcomponent s of the first repetition of field n. '' when absent. */
export function comp(seg: Hl7Segment, n: number, c = 1, s = 1): string {
  return repComp(field(seg, n)[0] ?? [], c, s);
}
/** Component c / subcomponent s of one repetition. '' when absent. */
export function repComp(rep: Hl7Repetition, c: number, s = 1): string {
  return rep[c - 1]?.[s - 1] ?? '';
}
