import type { CodingConfig } from '../coding/index.ts';
import type { HandlerTable } from './handler.ts';
import { charges } from './handlers/charges.ts';
import { demographics } from './handlers/demographics.ts';
import { discharge } from './handlers/discharge.ts';
import { documents } from './handlers/documents.ts';
import { merge } from './handlers/merge.ts';
import { intakeFor } from './intake.ts';
import { mapMdm, mapOru } from './map/document.ts';

/**
 * One table for both billing modes; the mode-dependent behaviour is inside the intake, so
 * this list of message types exists once. A type absent here is stored as unsupported.
 * MDM T04/T08/T10 are registered as corrections pending confirmation of what Cerner sends.
 */
export function handlersFor(coding: CodingConfig): HandlerTable {
  const intake = intakeFor(coding);
  return {
    'ADT^A01': demographics,
    'ADT^A04': demographics,
    'ADT^A08': demographics,
    'ADT^A28': demographics,
    'ADT^A31': demographics,
    'BAR^P01': demographics,
    'BAR^P05': demographics,
    'ADT^A03': discharge(intake),
    'ADT^A40': merge,
    'DFT^P03': charges(intake),
    'MDM^T02': documents(mapMdm, intake),
    'MDM^T04': documents(mapMdm, intake),
    'MDM^T08': documents(mapMdm, intake),
    'MDM^T10': documents(mapMdm, intake),
    'ORU^R01': documents(mapOru, intake),
  };
}
