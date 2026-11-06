import { cents, type Cents } from '../../domain/types.ts';

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Decimal text such as `125.00` or `-17.5` to exact cents. Undefined for '' or non-numeric text. */
export function parseMoney(text: string): Cents | undefined {
  const m = DECIMAL.exec(text.trim());
  if (!m) return undefined;
  const [, sign, whole = '', frac = ''] = m;
  if (whole === '' && frac === '') return undefined;
  const digits = frac.padEnd(3, '0');
  let value = Number(whole || '0') * 100 + Number(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) value += 1;
  if (value === 0) return cents(0);
  return cents(sign === '-' ? -value : value);
}
