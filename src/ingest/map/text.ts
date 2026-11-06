import type { Sex } from '../../domain/types.ts';

export const nonEmpty = (s: string): string | undefined => (s.trim() === '' ? undefined : s.trim());

const SEXES: ReadonlySet<string> = new Set<Sex>(['M', 'F', 'O']);

/** Undefined when the field is empty, so a later message without it does not overwrite a known value. */
export const mapSex = (s: string): Sex | undefined => (s === '' ? undefined : SEXES.has(s) ? (s as Sex) : 'U');
