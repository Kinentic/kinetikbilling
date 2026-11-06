import { randomUUID } from 'node:crypto';
import type { IsoDateTime } from './types.ts';

/** Fresh branded id. Call as newId<PatientId>(). */
export const newId = <T extends string>(): T => randomUUID() as T;

export const nowIso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;
