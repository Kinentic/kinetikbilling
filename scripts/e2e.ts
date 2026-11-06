// End-to-end proof: start the real app on ephemeral ports with an in-memory
// database, feed the Cerner fixtures through MLLP in clinical order, then
// drive a claim from build to payment over HTTP. Exits non-zero on any
// unexpected state. Run with `npm run e2e`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { loadConfig } from '../src/config.ts';
import { MllpDecoder, comp, encodeMllp, firstSegment, parseHl7 } from '../src/hl7/index.ts';
import { startApp } from '../src/main.ts';

// The duplicate record is a second registration of the same person under a new MRN, which the A40 then folds into the first.
const FIXTURES = ['adt-a04-register', 'bar-p01-account', 'adt-a08-update', 'dft-p03-charges', 'adt-a03-discharge', 'adt-a04-duplicate-record', 'adt-a40-merge'];

const config = loadConfig({ MLLP_PORT: '0', HTTP_PORT: '0', DB_PATH: ':memory:', MLLP_HOST: '127.0.0.1' });
const app = await startApp(config);
const base = `http://127.0.0.1:${app.httpPort}`;
const api = async (method: string, path: string, body?: unknown, contentType = 'application/json') => {
  const res = await fetch(base + path, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': contentType } }) });
  const text = await res.text();
  const parsed = res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
  return parsed;
};

const sendMllp = (raw: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port: app.mllpPort });
  const decoder = new MllpDecoder();
  socket.on('error', reject);
  socket.on('data', (chunk) => { for (const ack of decoder.feed(chunk)) { socket.end(); resolve(ack); } });
  socket.on('connect', () => socket.write(encodeMllp(raw)));
});

try {
  for (const name of FIXTURES) {
    const raw = readFileSync(`fixtures/hl7/${name}.hl7`, 'utf8');
    const ack = parseHl7(await sendMllp(raw));
    const msa = firstSegment(ack, 'MSA')!;
    console.log(`MLLP ${name.padEnd(20)} ${comp(msa, 1)} ${comp(msa, 3)}`);
    assert.equal(comp(msa, 1), 'AA', `${name} was not acknowledged`);
  }
  const dup = parseHl7(await sendMllp(readFileSync('fixtures/hl7/dft-p03-charges.hl7', 'utf8')));
  assert.equal(comp(firstSegment(dup, 'MSA')!, 1), 'AA', 'redelivered DFT must still be acknowledged');

  const messages = await api('GET', '/messages');
  const byStatus = Object.groupBy(messages, (m: { status: string }) => m.status);
  console.log(`messages stored: ${messages.length} (${Object.entries(byStatus).map(([k, v]) => `${k}=${v!.length}`).join(', ')})`);
  assert.equal(messages.length, FIXTURES.length, 'the duplicate must not create a second audit row');

  const patients = await api('GET', '/patients');
  const survivor = patients.find((p: { mergedInto?: string }) => !p.mergedInto);
  const merged = patients.find((p: { mergedInto?: string }) => p.mergedInto);
  assert.ok(survivor && merged, 'A40 must leave one survivor and one merged patient');
  console.log(`patients: survivor MRN ${survivor.mrn.value}, merged MRN ${merged.mrn.value} -> ${merged.mergedInto === survivor.id ? 'survivor' : '?'}`);

  const encounters = await api('GET', `/encounters?patientId=${survivor.id}`);
  assert.equal(encounters.length, 2, 'the merged patient\'s encounter must now belong to the survivor');
  const enc = await api('GET', `/encounters/${encounters.find((e: { accountNumber: string }) => e.accountNumber === 'FIN000123').id}`);
  console.log(`encounter ${enc.accountNumber}: class ${enc.patientClass}, admit ${enc.admitAt}, discharge ${enc.dischargeAt}, ${enc.coverages.length} coverages, ${enc.diagnoses.length} dx, ${enc.charges.length} charges`);
  assert.ok(enc.dischargeAt, 'A03 must set dischargeAt');
  assert.equal(enc.charges.length, 3, 'DFT redelivery must not duplicate charges');
  const net_ = enc.charges.reduce((t: number, c: { amount: number }) => t + c.amount, 0);
  assert.equal(net_, 12500, 'two charges and one credit net to the office visit alone');

  const claim = await api('POST', `/encounters/${enc.id}/claims`);
  console.log(`claim ${claim.controlNumber}: ${claim.status}, total ${(claim.totalCharge / 100).toFixed(2)}`);
  if (claim.status !== 'ready') {
    const detail = await api('GET', `/claims/${claim.id}`);
    console.log(JSON.stringify(detail.events.at(-1).detail, null, 2));
    assert.fail('claim did not scrub clean');
  }

  const submitted = await api('POST', `/claims/${claim.id}/submit`);
  const segs = submitted.edi.split('~\n').filter(Boolean);
  console.log(`837P: ${segs.length} segments, ${segs.filter((s: string) => s.startsWith('SV1*')).length} service lines`);
  console.log(submitted.edi.split('\n').slice(0, 4).join('\n'));
  assert.equal(submitted.claim.status, 'submitted');

  await api('POST', `/claims/${claim.id}/acknowledge`, { accepted: true, detail: { source: '277CA', code: 'A1' } });
  const paid = await api('POST', '/remittances', {
    controlNumber: claim.controlNumber, statusCode: '1', chargedAmount: 12500, paidAmount: 9000, patientResponsibility: 2000,
    adjustments: [{ group: 'CO', reasonCode: '45', amount: 1500 }], payerClaimControlNumber: 'PCN-E2E-1', checkNumber: 'EFT-1',
  });
  console.log(`remittance posted: ${paid.status}, paid ${paid.totalPaid}, adjusted ${paid.totalAdjusted}, patient ${paid.patientResponsibility}`);
  assert.equal(paid.status, 'paid');

  const ar = await api('GET', '/ar/summary');
  console.log(`AR: ${JSON.stringify(ar)}`);
  const final = await api('GET', `/claims/${claim.id}`);
  console.log(`lifecycle: ${final.events.map((e: { to: string }) => e.to).join(' -> ')}`);
  console.log('E2E OK');
} finally {
  await app.stop();
}
