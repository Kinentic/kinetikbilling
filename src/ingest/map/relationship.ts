import type { SubscriberRelationship } from '../../domain/types.ts';

const RELATIONSHIPS: Readonly<Record<string, SubscriberRelationship>> = {
  SEL: 'self', '01': 'self', '18': 'self', SELF: 'self',
  SPO: 'spouse', '02': 'spouse', '20': 'spouse', SPOUSE: 'spouse',
  CHD: 'child', '19': 'child', CHILD: 'child', DEP: 'child',
};

/** IN1-17 / GT1-11 code (HL7 0063, HL7 0344 or X12 style) to a relationship. Unknown codes are `other`. */
export const mapRelationship = (code: string): SubscriberRelationship => RELATIONSHIPS[code.trim().toUpperCase()] ?? 'other';
