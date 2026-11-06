import type { Store } from '../db/store.ts';
import { newId, nowIso } from '../domain/ids.ts';
import type { InboundMessage, InboundMessageStatus, IsoDateTime, MessageId } from '../domain/types.ts';
import { buildAck, formatHl7DateTime, parseHl7, type Hl7Message } from '../hl7/index.ts';
import type { HandlerTable } from './handler.ts';

export interface ProcessResult {
  ack: string;
  status: InboundMessageStatus;
  summary?: string;
  error?: string;
}

type Header = Pick<InboundMessage, 'controlId' | 'sendingApplication' | 'sendingFacility' | 'messageType' | 'triggerEvent'>;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Parses, dedupes on (MSH-4, MSH-10), dispatches through `handlers` and records an
 * InboundMessage for every outcome. Never throws: every failure becomes an AE or AR
 * acknowledgement. `handlers` is required (`handlersFor(config.coding)`), so no caller
 * inherits a billing mode by accident.
 */
export function processMessage(store: Store, raw: string, handlers: HandlerTable, now: IsoDateTime = nowIso()): ProcessResult {
  let msg: Hl7Message;
  try {
    msg = parseHl7(raw);
  } catch (e) {
    return reject(store, raw, now, salvageHeader(raw), errorText(e));
  }
  if (msg.header.controlId === '') return reject(store, raw, now, headerOf(msg), 'MSH-10 message control id is empty');
  try {
    return dispatch(store, msg, raw, handlers, now);
  } catch (e) {
    const error = errorText(e);
    return { ack: buildAck(msg, 'AE', error), status: 'error', error };
  }
}

const headerOf = (msg: Hl7Message): Header => ({
  controlId: msg.header.controlId,
  sendingApplication: msg.header.sendingApplication,
  sendingFacility: msg.header.sendingFacility,
  messageType: msg.header.messageType,
  triggerEvent: msg.header.triggerEvent,
});

function dispatch(store: Store, msg: Hl7Message, raw: string, handlers: HandlerTable, now: IsoDateTime): ProcessResult {
  const header = headerOf(msg);
  const prior = store.findMessage(header.sendingFacility, header.controlId);
  if (prior && prior.status !== 'error') return { ack: buildAck(msg, 'AA'), status: 'duplicate' };
  // A prior `error` row is a sender retry: reprocess and update that row in place.
  const id = prior?.id ?? newId<MessageId>();
  const record = (status: InboundMessageStatus, error?: string): void =>
    store.saveMessage({ id, ...header, receivedAt: now, raw, status, ...(error === undefined ? {} : { error }) });

  const type = `${header.messageType}^${header.triggerEvent}`;
  const handler = handlers[type];
  if (!handler) {
    // Acknowledged, not rejected: an AR/AE would stall Cerner's outbound queue over a message we do not bill from.
    record('unsupported');
    return { ack: buildAck(msg, 'AA', `Unsupported message type ${type}; stored`), status: 'unsupported' };
  }
  try {
    const { summary } = store.transaction(() => {
      const result = handler(store, msg, { now, messageId: id });
      record('accepted');
      return result;
    });
    return { ack: buildAck(msg, 'AA'), status: 'accepted', summary };
  } catch (e) {
    const error = errorText(e);
    record('error', error);
    return { ack: buildAck(msg, 'AE', error), status: 'error', error };
  }
}

/** Best-effort MSH read for a message the parser refused, so the audit row and the AR still name the sender. */
function salvageHeader(raw: string): Header {
  const msh = raw.split(/\r\n|\r|\n/)[0] ?? '';
  const sep = msh.startsWith('MSH') ? msh[3] : undefined;
  const parts = sep ? msh.split(sep) : [];
  const component = parts[1]?.[0] ?? '^';
  const at = (n: number, c = 1): string => parts[n - 1]?.split(component)[c - 1] ?? '';
  return {
    controlId: at(10), sendingApplication: at(3), sendingFacility: at(4), messageType: at(9, 1), triggerEvent: at(9, 2),
  };
}

const escapeText = (text: string): string =>
  text.replace(/[\\|^~&]|\r\n|\r|\n/g, (ch) => `\\${({ '\\': 'E', '|': 'F', '^': 'S', '~': 'R', '&': 'T' } as Record<string, string>)[ch] ?? '.br'}\\`);

/**
 * AR for a message that cannot be dispatched. The row is keyed on the salvaged
 * control id when that key is free (or holds an earlier error); otherwise on a
 * synthetic `unparsed:<id>` so the unique (facility, control id) key never
 * blocks the audit record.
 */
function reject(store: Store, raw: string, now: IsoDateTime, header: Header, error: string): ProcessResult {
  const id = newId<MessageId>();
  const ack = `MSH|^~\\&|KINETIK|BILLING|||${formatHl7DateTime(new Date(now))}||ACK|${newId<MessageId>()}|P|2.5.1\r`
    + `MSA|AR|${escapeText(header.controlId)}|${escapeText(error)}\r`;
  try {
    const prior = header.controlId ? store.findMessage(header.sendingFacility, header.controlId) : undefined;
    const keep = header.controlId !== '' && (prior === undefined || prior.status === 'error');
    store.saveMessage({
      ...header,
      id: prior?.status === 'error' ? prior.id : id,
      controlId: keep ? header.controlId : `unparsed:${id}`,
      receivedAt: now, raw, status: 'error', error,
    });
  } catch (e) {
    return { ack, status: 'error', error: `${error}; audit record not saved: ${errorText(e)}` };
  }
  return { ack, status: 'error', error };
}
