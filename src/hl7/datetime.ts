import type { IsoDate, IsoDateTime } from '../domain/types.ts';

const DTM = /^(\d{4})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.(\d{1,4}))?)?)?)?)?)?([+-]\d{4})?$/;
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

function validDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** HL7 TS/DTM (YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ]) to ISO 8601. Undefined for '' or unparseable. */
export function parseHl7DateTime(ts: string): IsoDateTime | undefined {
  const m = DTM.exec(ts.trim());
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', frac, off] = m;
  if (!validDay(Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined;
  let offset = '+00:00'; // a value without an offset is treated as UTC wall time and not converted
  if (off) {
    if (Number(off.slice(3)) > 59) return undefined;
    offset = `${off.slice(0, 3)}:${off.slice(3)}`;
  }
  const fraction = frac ? `.${frac.slice(0, 3).padEnd(3, '0')}` : '';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${fraction}${offset}` as IsoDateTime;
}

/** First 8 digits of an HL7 TS/DT to YYYY-MM-DD. Undefined for '' or unparseable. */
export function parseHl7Date(ts: string): IsoDate | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(ts.trim());
  if (!m || !validDay(Number(m[2]), Number(m[3]))) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}` as IsoDate;
}

/** Date to HL7 DTM with offset, e.g. 20261105143000-0800. */
export function formatHl7DateTime(d: Date): string {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}
