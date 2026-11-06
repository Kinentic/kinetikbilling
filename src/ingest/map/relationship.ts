import type { SubscriberRelationship } from '../../domain/types.ts';

// HL7 table 0063 mnemonics plus the X12 individual relationship codes Cerner
// often sends in their place (18 self, 01 spouse, 19 child). 20 (employee) and
// 21 (unknown) fall through to `other`.
const RELATIONSHIPS: Readonly<Record<string, SubscriberRelationship>> = {
  SEL: 'self', SELF: 'self', '18': 'self',
  SPO: 'spouse', SPOUSE: 'spouse', DOM: 'spouse', '01': 'spouse',
  CHD: 'child', NCH: 'child', SCH: 'child', FCH: 'child', GCH: 'child', DEP: 'child', CHILD: 'child', '19': 'child',
};

/** IN1-17 / GT1-11 code to a relationship. Unknown codes are `other`. */
export const mapRelationship = (code: string): SubscriberRelationship => RELATIONSHIPS[code.trim().toUpperCase()] ?? 'other';
