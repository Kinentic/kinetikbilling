import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { loadConfig } from '../config.ts';
import { SAMPLE_835, addCharge, seed } from '../claims/testkit.ts';
import { buildRouter } from './routes.ts';

const serve = async () => {
  const s = seed();
  addCharge(s, { externalId: 'T0001' });
  addCharge(s, { externalId: 'T0002', code: '36415', amount: 1700 as never });
  const ingested: string[] = [];
  const router = buildRouter({ store: s.store, config: loadConfig({}), ingest: (raw) => { ingested.push(raw); return { ack: 'ACK', status: 'accepted' }; } });
  const server = http.createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown, contentType = 'application/json') => {
    const res = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }),
    });
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };
  return { ...s, ingested, call, close: () => new Promise<void>((r) => server.close(() => r())) };
};

test('claim lifecycle over HTTP: build, 837P, submit, post 835, AR summary', async () => {
  const t = await serve();
  try {
    const built = await t.call('POST', `/encounters/${t.encounterId}/claims`);
    assert.equal(built.status, 200);
    assert.equal(built.body.status, 'ready');
    assert.equal(built.body.controlNumber, 'FIN000123-1');
    assert.equal(built.body.totalCharge, 12550 + 1700);

    const again = await t.call('POST', `/encounters/${t.encounterId}/claims`);
    assert.equal(again.body.id, built.body.id, 'rebuilding with nothing new converges on the same claim');

    const edi = await t.call('GET', `/claims/${built.body.id}/837p`);
    assert.equal(edi.status, 200);
    assert.match(edi.body, /^ISA\*00\*/);
    assert.match(edi.body, /CLM\*FIN000123-1\*142\.50\*/);

    const submitted = await t.call('POST', `/claims/${built.body.id}/submit`);
    assert.equal(submitted.body.claim.status, 'submitted');
    assert.match(submitted.body.edi, /ST\*837\*/);

    const posted = await t.call('POST', '/remittances/835', SAMPLE_835, 'text/plain');
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.body[0], { controlNumber: 'FIN000123-1', posted: true, status: 'paid' });
    assert.equal(posted.body[1].posted, false, 'the second CLP names a claim we do not have');

    const detail = await t.call('GET', `/claims/${built.body.id}`);
    assert.equal(detail.body.payments.length, 1);
    assert.equal(detail.body.events.at(-1).to, 'paid');

    const ar = await t.call('GET', '/ar/summary');
    assert.deepEqual(ar.body.map((r: { status: string; count: number }) => [r.status, r.count]), [['paid', 1]]);
  } finally {
    await t.close();
  }
});

test('domain errors map to HTTP statuses at the boundary', async () => {
  const t = await serve();
  try {
    assert.equal((await t.call('GET', '/claims/nope')).status, 404);
    assert.equal((await t.call('POST', '/encounters/nope/claims')).status, 404);
    const built = await t.call('POST', `/encounters/${t.encounterId}/claims`);
    const ack = await t.call('POST', `/claims/${built.body.id}/acknowledge`, { accepted: true });
    assert.equal(ack.status, 409, 'ready → accepted is not a legal transition');
    assert.match(ack.body.error, /cannot move from ready to accepted/);
    assert.equal((await t.call('GET', '/claims?status=bogus')).status, 400);
    assert.equal((await t.call('POST', '/remittances', { controlNumber: 'x' })).status, 400);
  } finally {
    await t.close();
  }
});

test('raw HL7 posted over HTTP goes through ingest and returns its ACK', async () => {
  const t = await serve();
  try {
    const res = await t.call('POST', '/hl7', 'MSH|^~\\&|CERNER|HOSP|||20261105||ADT^A04|1|P|2.5.1\r', 'text/plain');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');
    assert.equal(t.ingested.length, 1);
    assert.equal((await t.call('POST', '/hl7')).status, 400);
  } finally {
    await t.close();
  }
});
