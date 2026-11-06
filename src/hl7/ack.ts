import { formatHl7DateTime } from './datetime.ts';
import type { AckCode, Hl7Encoding, Hl7Message } from './message.ts';

let counter = 0;

function newControlId(): string {
  counter = (counter + 1) % 1_679_616; // 36^4
  return `K${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}`;
}

function escapeText(text: string, e: Hl7Encoding): string {
  const out = text.replace(/\r\n|\r|\n/g, '\u0000');
  const map: Record<string, string> = {
    [e.escape]: 'E', [e.field]: 'F', [e.component]: 'S', [e.repetition]: 'R', [e.subcomponent]: 'T', '\u0000': '.br',
  };
  let res = '';
  for (const ch of out) {
    const code = map[ch];
    res += code === undefined ? ch : `${e.escape}${code}${e.escape}`;
  }
  return res;
}

/**
 * Build an ACK^<trigger> for msg (MSA-1 = code, MSA-2 = original control id,
 * MSA-3 = text). Sending/receiving apps and facilities are swapped. The result
 * is a complete raw message with \r segment terminators and no MLLP framing.
 */
export function buildAck(msg: Hl7Message, code: AckCode, text = ''): string {
  const e = msg.encoding;
  const h = msg.header;
  const x = (s: string): string => escapeText(s, e);
  const msh = [
    'MSH',
    `${e.component}${e.repetition}${e.escape}${e.subcomponent}`,
    x(h.receivingApplication), x(h.receivingFacility), x(h.sendingApplication), x(h.sendingFacility),
    formatHl7DateTime(new Date()),
    '',
    ['ACK', x(h.triggerEvent), 'ACK'].join(e.component),
    newControlId(),
    x(h.processingId || 'P'),
    x(h.version),
  ].join(e.field);
  const msa = ['MSA', code, x(h.controlId), x(text)].join(e.field);
  return `${msh}\r${msa}\r`;
}
