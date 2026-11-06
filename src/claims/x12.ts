import type { Cents, IsoDate } from '../domain/types.ts';

export type X12Element = string | readonly (string | undefined)[] | undefined;

/** `*`, `~`, `:` and `^` are this writer's separators (`^` is the ISA11 repetition separator). */
const sanitize = (v: string | undefined): string => (v ?? '').replace(/[*~:^\r\n]/g, ' ').trim();

const trimTrailing = (parts: string[]): string[] => {
  let end = parts.length;
  while (end > 0 && parts[end - 1] === '') end--;
  return parts.slice(0, end);
};

const element = (e: X12Element): string =>
  typeof e === 'string' || e === undefined ? sanitize(e) : trimTrailing(e.map(sanitize)).join(':');

export interface IsaHeader {
  senderId: string;
  receiverId: string;
  controlNumber: number;
  now: Date;
  usage?: 'P' | 'T';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** CCYYMMDD and HHMM in UTC, so output does not depend on the host time zone. */
export const x12Date = (d: Date): string => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
export const x12Time = (d: Date): string => `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
export const isoToX12Date = (d: IsoDate): string => d.replaceAll('-', '');

export const formatAmount = (c: Cents): string => {
  const abs = Math.abs(c);
  return `${c < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export const interchangeControl = (n: number): string => String(n).padStart(9, '0');

export class X12Writer {
  readonly #segments: string[] = [];
  readonly #newline: boolean;

  constructor(opts: { newline?: boolean } = {}) {
    this.#newline = opts.newline ?? true;
  }

  /** Segments written so far, ISA included. */
  get count(): number {
    return this.#segments.length;
  }

  seg(id: string, ...elements: X12Element[]): this {
    this.#segments.push([id, ...trimTrailing(elements.map(element))].join('*') + '~');
    return this;
  }

  /** ISA is fixed width and carries the separators themselves, so it bypasses sanitizing. */
  isa(h: IsaHeader): this {
    const fixed = (v: string, n: number) => sanitize(v).slice(0, n).padEnd(n, ' ');
    const blank10 = ' '.repeat(10);
    this.#segments.push([
      'ISA', '00', blank10, '00', blank10, 'ZZ', fixed(h.senderId, 15), 'ZZ', fixed(h.receiverId, 15),
      x12Date(h.now).slice(2), x12Time(h.now), '^', '00501', interchangeControl(h.controlNumber), '0', h.usage ?? 'P', ':',
    ].join('*') + '~');
    return this;
  }

  toString(): string {
    return this.#segments.join(this.#newline ? '\n' : '') + (this.#newline ? '\n' : '');
  }
}
