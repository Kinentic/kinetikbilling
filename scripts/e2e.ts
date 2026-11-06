// End-to-end proof: start the real app on ephemeral ports with an in-memory database in
// coder mode with every release sampled for QA, feed the Cerner fixtures through MLLP in
// clinical order, and drive the coding task over HTTP: discharge opens it, the DFT proposes,
// the note makes it ready, a coder starts it, holds on a query, resumes, decides the
// proposals, releases through QA to fee-schedule-priced charges and a claim, a corrected note
// reopens the task, the re-release voids only the changed line and rebuilds the same claim,
// which is then submitted, acknowledged and paid. Exits non-zero on any unexpected state.
// Run with `npm run e2e`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { loadConfig } from '../src/config.ts';
import { MllpDecoder, comp, encodeMllp, firstSegment, parseHl7 } from '../src/hl7/index.ts';
import { startApp } from '../src/main.ts';

// The duplicate record is a second registration of the same person under a new MRN, which the A40 then folds into the first.
const FIXTURES = [
  'adt-a04-register', 'bar-p01-account', 'adt-a08-update',
  'adt-a03-discharge',             // task created: awaiting_documentation, due 48 hours after discharge
  'dft-p03-charges',               // proposals: 99213, 36415 then its CD as a pending removal, dx R07.9; no charges
  'oru-r01-radiology-preliminary', // document v1 preliminary: no task fact
  'mdm-t02-progress-note',         // document final: awaiting_documentation -> ready_to_code, specialty primary_care
  'oru-r01-radiology-final',       // document v2 final: task already ready; nothing moves
  'adt-a04-duplicate-record', 'adt-a40-merge',
];

const config = loadConfig({ MLLP_PORT: '0', HTTP_PORT: '0', DB_PATH: ':memory:', MLLP_HOST: '127.0.0.1', BILLING_MODE: 'coder', DOCUMENTATION_GRACE_HOURS: '48', QA_SAMPLE_PERCENT: '100' });
const app = await startApp(config);
const base = `http://127.0.0.1:${app.httpPort}`;
const call = async (method: string, path: string, body?: unknown, contentType = 'application/json') => {
  const res = await fetch(base + path, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }) });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, text };
};
const api = async (method: string, path: string, body?: unknown, contentType = 'application/json') => {
  const res = await call(method, path, body, contentType);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} -> ${res.status} ${res.text}`);
  return res.body;
};

const sendMllp = (raw: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port: app.mllpPort });
  const decoder = new MllpDecoder();
  socket.on('error', reject);
  socket.on('data', (chunk) => { for (const ack of decoder.feed(chunk)) { socket.end(); resolve(ack); } });
  socket.on('connect', () => socket.write(encodeMllp(raw)));
});
const fixture = (name: string): string => readFileSync(`fixtures/hl7/${name}.hl7`, 'utf8');
const withControlId = (raw: string, id: string): string => raw.replace(/^(MSH(?:\|[^|\r]*){8}\|)[^|\r]*/, `$1${id}`);
const send = async (name: string, raw = fixture(name)): Promise<void> => {
  const msa = firstSegment(parseHl7(await sendMllp(raw)), 'MSA')!;
  console.log(`MLLP ${name.padEnd(30)} ${comp(msa, 1)} ${comp(msa, 3)}`);
  assert.equal(comp(msa, 1), 'AA', `${name} was not acknowledged`);
};
const encounterFin123 = async () => {
  const encounters = await api('GET', '/encounters');
  return api('GET', `/encounters/${encounters.find((e: { accountNumber: string }) => e.accountNumber === 'FIN000123').id}`);
};
const taskLine = (t: { status: string; specialty?: string; assignee?: string; documentationDueAt?: string }) =>
  `task: ${t.status}${t.specialty ? `, ${t.specialty}` : ''}${t.assignee ? `, assigned ${t.assignee}` : ''}${t.documentationDueAt ? `, documentation due ${t.documentationDueAt}` : ''}`;

try {
  for (const name of FIXTURES) {
    await send(name);
    if (name === 'adt-a03-discharge') {
      // Decision 7: the A03 opened the task with a deadline; overdue is a read filter, so nothing waits for a clock.
      const enc = await encounterFin123();
      console.log(taskLine(enc.task));
      assert.equal(enc.task.status, 'awaiting_documentation');
      assert.equal(enc.task.documentationDueAt, '2026-11-10T18:15:00.000Z', '48 hours after the PV1-45 discharge time');
      const overdue = await api('GET', '/coding/tasks?status=awaiting_documentation&overdue=true&asOf=2026-11-10T19:00:00Z');
      assert.deepEqual(overdue.map((t: { id: string }) => t.id), [enc.task.id], 'listed once the deadline has passed');
      assert.deepEqual(await api('GET', '/coding/tasks?status=awaiting_documentation&overdue=true&asOf=2026-11-08T19:00:00Z'), [], 'not listed before it');
    }
    if (name === 'dft-p03-charges') {
      const enc = await encounterFin123();
      assert.equal(enc.charges.length, 0, 'in coder mode a DFT bills nothing');
      const codes = await api('GET', `/coding/tasks/${enc.task.id}/codes`);
      const pending = codes.lines.filter((l: { pending: boolean }) => l.pending);
      console.log(`proposals: ${pending.map((l: { current: { content: { code: string }; removed: boolean } }) => `${l.current.content.code}${l.current.removed ? ' (removal)' : ''}`).join(', ')}`);
      assert.equal(pending.length, 3, '99213, the retracted 36415, and R07.9 wait for the coder');
      assert.equal(enc.task.status, 'awaiting_documentation', 'proposals alone do not make a task ready');
    }
  }
  await send('dft-p03-charges (redelivered)', fixture('dft-p03-charges'));
  await send('mdm-t02-progress-note (new MSH-10)', withControlId(fixture('mdm-t02-progress-note'), 'HOSP00000099'));

  const messages = await api('GET', '/messages');
  const byStatus = Object.groupBy(messages, (m: { status: string }) => m.status);
  console.log(`messages stored: ${messages.length} (${Object.entries(byStatus).map(([k, v]) => `${k}=${v!.length}`).join(', ')})`);
  assert.equal(messages.length, FIXTURES.length + 1, 'the duplicate adds no audit row; the resend under a new control id adds one');

  const patients = await api('GET', '/patients');
  const survivor = patients.find((p: { mergedInto?: string }) => !p.mergedInto);
  const merged = patients.find((p: { mergedInto?: string }) => p.mergedInto);
  assert.ok(survivor && merged, 'A40 must leave one survivor and one merged patient');
  console.log(`patients: survivor MRN ${survivor.mrn.value}, merged MRN ${merged.mrn.value} -> ${merged.mergedInto === survivor.id ? 'survivor' : '?'}`);
  assert.equal((await api('GET', `/encounters?patientId=${survivor.id}`)).length, 2, 'the merged patient\'s encounter must now belong to the survivor');

  const enc = await encounterFin123();
  console.log(`encounter ${enc.accountNumber}: class ${enc.patientClass}, admit ${enc.admitAt}, discharge ${enc.dischargeAt}, ${enc.coverages.length} coverages, ${enc.diagnoses.length} dx, ${enc.charges.length} charges, ${enc.documents.length} documents`);
  assert.equal(enc.charges.length, 0, 'nothing is billed without a release');
  assert.deepEqual(enc.documents.map((d: { current: { externalId: string; version: number; status: string } }) => [d.current.externalId, d.current.version, d.current.status]).sort(),
    [['DOC0001', 1, 'final'], ['RAD5501', 2, 'final']], 'the resent note added no version; the final read is version 2');
  const radiology = await api('GET', `/documents/${enc.documents.find((d: { current: { externalId: string } }) => d.current.externalId === 'RAD5501').current.id}`);
  assert.deepEqual(radiology.versions.map((v: { version: number; status: string }) => [v.version, v.status]), [[2, 'final'], [1, 'preliminary']]);

  const [ready] = await api('GET', '/coding/tasks?status=ready_to_code');
  assert.ok(ready && ready.id === enc.task.id, 'one task, ready once the final note arrived');
  console.log(taskLine(ready));
  assert.equal(ready.specialty, 'primary_care');
  const view = await api('GET', `/coding/tasks/${ready.id}`);
  assert.deepEqual(view.events.map((e: { to: string }) => e.to), ['awaiting_documentation', 'ready_to_code'], 'the resent note and the second final raised no event');

  await api('POST', `/coding/tasks/${ready.id}/assign`, { assignee: 'coder-1' });
  const started = await api('POST', `/coding/tasks/${ready.id}/start`, { coder: 'coder-1' });
  console.log(taskLine(started));
  assert.equal(started.status, 'in_progress');

  const held = await api('POST', `/coding/tasks/${ready.id}/queries`, { coder: 'coder-1', question: 'Confirm total time for E/M level', channel: 'in_app' });
  console.log(`${taskLine(held.task)} (query ${held.query.id})`);
  assert.equal(held.task.status, 'on_hold_query');
  const answered = await api('POST', `/coding/queries/${held.query.id}/answer`, { answer: '22 minutes' });
  console.log(`${taskLine(answered.task)} (answer: ${answered.query.answer.text})`);
  assert.equal(answered.task.status, 'in_progress');

  const codes = await api('GET', `/coding/tasks/${ready.id}/codes`);
  const pending = codes.lines.filter((l: { pending: boolean }) => l.pending);
  assert.equal(pending.length, 3);
  const decided = await api('POST', `/coding/tasks/${ready.id}/codes`, {
    coder: 'coder-1', edits: pending.map((l: { lineId: string; current: { id: string } }) => ({ op: 'accept', lineId: l.lineId, basedOn: l.current.id })),
  });
  console.log(`codes: ${decided.lines.map((l: { current: { content: { code: string }; removed: boolean; provenance: string } }) => `${l.current.content.code}${l.current.removed ? ' removed' : ''} (${l.current.provenance})`).join(', ')}`);
  assert.equal(decided.lines.filter((l: { pending: boolean }) => l.pending).length, 0, 'every proposal is decided');
  assert.ok(decided.lines.every((l: { current: { provenance: string } }) => l.current.provenance === 'cerner_dft'), 'accepting keeps the Cerner provenance');

  const final = await api('GET', `/coding/tasks/${ready.id}`);
  console.log(`task lifecycle: ${final.events.map((e: { to: string }) => e.to).join(' -> ')}`);
  console.log(`charges on the encounter: ${(await encounterFin123()).charges.length}`);

  const taskId: string = ready.id;
  const rules = (violations: { rule: string }[]) => violations.map((v) => v.rule);
  const lineOf = async (code: string) => (await api('GET', `/coding/tasks/${taskId}/codes`)).lines.find((l: { current: { content: { code: string }; removed: boolean } }) => l.current.content.code === code && !l.current.removed);
  const taskEvents = async () => (await api('GET', `/coding/tasks/${taskId}`)).events.map((e: { to: string }) => e.to);
  const changeLine = async (code: string, content: Record<string, unknown>) => {
    const line = await lineOf(code);
    return api('POST', `/coding/tasks/${taskId}/codes`, { coder: 'coder-1', edits: [{ op: 'change', lineId: line.lineId, basedOn: line.current.id, content: { ...line.current.content, ...content } }] });
  };

  assert.deepEqual(rules(decided.violations), ['fee-on-file'], 'decided, resolved, and rendered by the note author; only the price is missing');
  const unpriced = await call('POST', `/coding/tasks/${taskId}/release`, { coder: 'coder-1' });
  console.log(`release without a fee schedule: ${unpriced.status} ${unpriced.body.error} (${rules(unpriced.body.detail).join(', ')})`);
  assert.equal(unpriced.status, 422);
  assert.deepEqual(rules(unpriced.body.detail), ['fee-on-file']);
  assert.equal((await encounterFin123()).charges.length, 0, 'a blocked release writes nothing');

  const fees = await api('PUT', '/fee-schedule', { lines: [
    { code: '99213', modifiers: [], amount: 12500, effectiveFrom: '2026-01-01' },
    { code: '99214', modifiers: [], amount: 18000, effectiveFrom: '2026-01-01' },
    { code: '36415', modifiers: [], amount: 1700, effectiveFrom: '2026-01-01' },
  ] });
  console.log(`fee schedule: ${fees.map((f: { code: string; amount: number }) => `${f.code}=${f.amount}`).join(' ')}`);
  assert.deepEqual(await api('GET', '/fee-schedule'), fees);
  assert.deepEqual(rules((await api('GET', `/coding/tasks/${taskId}/codes`)).violations), []);

  const sampled = await api('POST', `/coding/tasks/${taskId}/release`, { coder: 'coder-1' });
  console.log(`release 1: ${sampled.kind} (${taskLine(sampled.task)})`);
  assert.equal(sampled.kind, 'qa_review', 'QA_SAMPLE_PERCENT=100 samples every release');
  const eventsInQa = await taskEvents();
  assert.equal((await api('POST', `/coding/tasks/${taskId}/release`, { coder: 'coder-1' })).kind, 'qa_review');
  assert.deepEqual(await taskEvents(), eventsInQa, 'a repeat release while in QA writes nothing');

  const returned = await api('POST', `/coding/tasks/${taskId}/qa`, { reviewer: 'lead-1', outcome: 'return', notes: 'add I10' });
  console.log(`qa return: ${taskLine(returned.task)}`);
  assert.equal(returned.task.status, 'returned_to_coder');
  assert.equal((await api('POST', `/coding/tasks/${taskId}/start`, { coder: 'coder-1' })).status, 'in_progress');
  await api('POST', `/coding/tasks/${taskId}/codes`, { coder: 'coder-1', edits: [{ op: 'add', content: { kind: 'diagnosis', code: 'I10', sequence: 2, description: 'Essential hypertension' } }] });
  const recoded = await changeLine('99213', { diagnosisCodes: ['R07.9', 'I10'] });
  assert.deepEqual(rules(recoded.violations), []);

  assert.equal((await api('POST', `/coding/tasks/${taskId}/release`, { coder: 'coder-1' })).kind, 'qa_review');
  const first = await api('POST', `/coding/tasks/${taskId}/qa`, { reviewer: 'lead-1', outcome: 'agree' });
  console.log(`qa agree: ${first.kind} ${first.releaseNumber}, charges created ${first.charges.created.length} voided ${first.charges.voided.length} kept ${first.charges.kept.length}, claim ${first.claim.kind} ${first.claim.claim?.status} ${first.claim.claim?.totalCharge}`);
  assert.equal(first.kind, 'released');
  assert.deepEqual([first.releaseNumber, first.charges.created.length, first.charges.voided, first.charges.kept], [1, 1, [], []]);
  assert.deepEqual([first.claim.kind, first.claim.claim.status, first.claim.claim.totalCharge], ['built', 'ready', 12500]);
  const claimId: string = first.claim.claim.id;
  const charges1 = await api('GET', `/charges?encounterId=${enc.id}`);
  assert.deepEqual(charges1.map((c: { source: string; status: string; amount: number; code: string }) => [c.source, c.code, c.status, c.amount]), [['coder', '99213', 'claimed', 12500]], 'priced from the fee schedule, not FT1-11');

  await send('mdm-t08-corrected-note');
  const reopened = await api('GET', `/coding/tasks/${taskId}`);
  console.log(`${taskLine(reopened.task)} (${reopened.events.at(-1).reason}); claim ${(await api('GET', `/claims/${claimId}`)).status}`);
  assert.deepEqual([reopened.task.status, reopened.events.at(-1).reason], ['in_progress', 'document corrected']);
  assert.equal((await api('GET', `/claims/${claimId}`)).status, 'draft', 'the reopen parks the claim');
  assert.deepEqual(reopened.documents.find((d: { current: { externalId: string } }) => d.current.externalId === 'DOC0001').priorVersions.length, 1, 'the corrected note is version 2');

  await changeLine('99213', { code: '99214' });
  assert.equal((await api('POST', `/coding/tasks/${taskId}/release`, { coder: 'coder-1' })).kind, 'qa_review');
  const second = await api('POST', `/coding/tasks/${taskId}/qa`, { reviewer: 'lead-1', outcome: 'agree', notes: 'level supported by the addendum' });
  console.log(`qa agree: ${second.kind} ${second.releaseNumber}, charges created ${second.charges.created.length} voided ${second.charges.voided.length} kept ${second.charges.kept.length}, claim ${second.claim.kind} ${second.claim.claim?.status} ${second.claim.claim?.totalCharge}`);
  assert.deepEqual([second.releaseNumber, second.charges.created.length, second.charges.voided, second.charges.kept], [2, 1, [charges1[0].id], []]);
  assert.deepEqual([second.claim.claim.id, second.claim.claim.status, second.claim.claim.totalCharge], [claimId, 'ready', 18000], 'the same claim, rebuilt with the new total');
  const charges2 = await api('GET', `/charges?encounterId=${enc.id}`);
  assert.deepEqual(charges2.map((c: { code: string; status: string }) => [c.code, c.status]).sort(), [['99213', 'voided'], ['99214', 'claimed']]);

  const repeat = await api('POST', `/coding/tasks/${taskId}/release`, { coder: 'coder-1' });
  console.log(`release again: ${repeat.kind}, created ${repeat.charges.created.length} voided ${repeat.charges.voided.length} kept ${repeat.charges.kept.length}, claim ${repeat.claim.kind}`);
  assert.deepEqual([repeat.kind, repeat.charges.created, repeat.charges.voided, repeat.charges.kept.length, repeat.claim.kind], ['released', [], [], 1, 'built']);

  const submitted = await api('POST', `/claims/${claimId}/submit`);
  const segments: string[] = submitted.edi.split('\n').map((seg: string) => seg.replace(/~$/, ''));
  const sv1 = segments.filter((seg) => seg.startsWith('SV1'));
  const hi = segments.find((seg) => seg.startsWith('HI'));
  console.log(`837P: ${hi}; ${sv1.join('; ')}`);
  assert.equal(submitted.claim.status, 'submitted');
  assert.equal(sv1.length, 1);
  assert.match(sv1[0] ?? '', /^SV1\*HC:99214/);
  assert.equal(hi, 'HI*ABK:R079*ABF:I10');
  assert.equal((await api('POST', `/claims/${claimId}/acknowledge`, { accepted: true })).status, 'accepted');
  const paid = await api('POST', '/remittances', {
    controlNumber: submitted.claim.controlNumber, statusCode: '1', chargedAmount: 18000, paidAmount: 13000, patientResponsibility: 2000, adjustments: [{ group: 'CO', reasonCode: '45', amount: 3000 }],
  });
  console.log(`claim ${paid.controlNumber}: ${paid.status}, paid ${paid.totalPaid}, adjusted ${paid.totalAdjusted}, patient ${paid.patientResponsibility}`);
  assert.equal(paid.status, 'paid');

  const taskHistory = await taskEvents();
  const claimHistory = (await api('GET', `/claims/${claimId}`)).events.map((e: { to: string }) => e.to);
  console.log(`task lifecycle: ${taskHistory.join(' -> ')}`);
  console.log(`claim lifecycle: ${claimHistory.join(' -> ')}`);
  assert.deepEqual(taskHistory, [
    'awaiting_documentation', 'ready_to_code', 'in_progress', 'on_hold_query', 'in_progress', 'coded', 'qa_review', 'returned_to_coder', 'in_progress', 'coded', 'qa_review', 'released',
    'in_progress', 'coded', 'qa_review', 'released',
  ]);
  assert.deepEqual(claimHistory, ['draft', 'ready', 'draft', 'ready', 'submitted', 'accepted', 'paid']);

  const corrected = (await api('GET', '/messages')).find((m: { controlId: string }) => m.controlId === 'HOSP00000011');
  const replay = await api('POST', `/messages/${corrected.id}/replay`);
  console.log(`replay of the corrected note: ${replay.status}`);
  assert.equal(replay.status, 'duplicate');
  assert.deepEqual(await taskEvents(), taskHistory, 'a replay moves nothing');
  assert.equal((await encounterFin123()).documents.find((d: { current: { externalId: string } }) => d.current.externalId === 'DOC0001').priorVersions.length, 1);

  console.log('E2E OK');
} finally {
  await app.stop();
}
