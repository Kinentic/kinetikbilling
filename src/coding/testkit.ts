// Shared seeds for the coding tests: an encounter with a task in a chosen status, documents, and proposals.

import { seed, type Seeded } from '../claims/testkit.ts';
import { newId, nowIso } from '../domain/ids.ts';
import type { CodingTask, CodingTaskId, Document, DocumentId, IsoDate, IsoDateTime, MessageId, TaskStatus } from '../domain/types.ts';
import type { CernerLine } from './codes.ts';

export const AT = '2026-11-08T18:00:00.000Z' as IsoDateTime;

export interface SeededTask extends Seeded { task: CodingTask }

/** A task in `status`, seeded through the Store with a single opening event, so any status can be reached without release. */
export const seedTask = (status: TaskStatus, extra: Partial<CodingTask> = {}): SeededTask => {
  const s = seed();
  const task: CodingTask = { id: newId<CodingTaskId>(), encounterId: s.encounterId, status, origin: { kind: 'discharge', messageId: newId<MessageId>() }, createdAt: AT, updatedAt: AT, ...extra };
  s.store.insertTask(task, { taskId: task.id, at: AT, from: null, to: status, reason: 'seeded' });
  return { ...s, task };
};

export const doc = (encounterId: Document['encounterId'], overrides: Partial<Document> = {}): Document => ({
  id: newId<DocumentId>(), encounterId, messageId: newId<MessageId>(), externalId: 'DOC0001', version: 1, kind: 'progress_note', status: 'final', body: 'note',
  author: { npi: '1234567893', lastName: 'Smith', firstName: 'Robert' }, recordedAt: nowIso(), ...overrides,
});

export const cernerLine = (sourceRef: string, overrides: Partial<CernerLine> = {}): CernerLine => ({
  sourceRef, reversal: false,
  procedure: { kind: 'procedure', codeSystem: 'CPT', code: '99213', modifiers: ['25'], units: 1, serviceDate: '2026-11-05' as IsoDate, diagnosisCodes: ['R07.9'] },
  diagnoses: [{ code: 'R07.9', description: 'Chest pain, unspecified' }],
  ...overrides,
});
