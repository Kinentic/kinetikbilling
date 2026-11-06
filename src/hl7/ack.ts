import type { AckCode, Hl7Message } from './message.ts';

/**
 * Build an ACK^<trigger> for msg (MSA-1 = code, MSA-2 = original control id,
 * MSA-3 = text). Sending/receiving apps and facilities are swapped. The result
 * is a complete raw message with \r segment terminators and no MLLP framing.
 */
export function buildAck(_msg: Hl7Message, _code: AckCode, _text?: string): string {
  throw new Error('hl7/ack not implemented');
}
