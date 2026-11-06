import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { MAX_FRAME_BYTES, MllpDecoder, buildAck, encodeMllp, parseHl7, startMllpServer } from './index.ts';

test('encodeMllp wraps with VT ... FS CR', () => {
  const b = encodeMllp('MSH|x');
  assert.equal(b[0], 0x0b);
  assert.deepEqual([...b.subarray(-2)], [0x1c, 0x0d]);
  assert.equal(b.subarray(1, -2).toString(), 'MSH|x');
});

test('decoder reassembles a frame split across three chunks', () => {
  const d = new MllpDecoder();
  const b = encodeMllp('MSH|abc\rPID|1\r');
  assert.deepEqual(d.feed(b.subarray(0, 4)), []);
  assert.deepEqual(d.feed(b.subarray(4, b.length - 1)), []);
  assert.deepEqual(d.feed(b.subarray(b.length - 1)), ['MSH|abc\rPID|1\r']);
});

test('decoder returns two frames delivered in one chunk and drops bytes before a start block', () => {
  const d = new MllpDecoder();
  const chunk = Buffer.concat([Buffer.from('noise'), encodeMllp('one'), encodeMllp('two'), Buffer.from([0x0b, 0x41])]);
  assert.deepEqual(d.feed(chunk), ['one', 'two']);
  assert.deepEqual(d.feed(Buffer.concat([Buffer.from('BC'), Buffer.from([0x1c, 0x0d])])), ['ABC']);
});

test('decoder handles multibyte characters split across chunks', () => {
  const d = new MllpDecoder();
  const b = encodeMllp('NTE|é');
  assert.deepEqual([...d.feed(b.subarray(0, 6)), ...d.feed(b.subarray(6))], ['NTE|é']);
});

async function readFrames(socket: net.Socket, count: number): Promise<string[]> {
  const d = new MllpDecoder();
  const got: string[] = [];
  return new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', (c) => { got.push(...d.feed(c)); if (got.length >= count) resolve(got); });
  });
}

test('server on port 0 ACKs each framed message in order on the same socket', async () => {
  const seen: string[] = [];
  const server = await startMllpServer({
    port: 0,
    host: '127.0.0.1',
    onMessage: async (raw) => {
      const m = parseHl7(raw);
      await new Promise((r) => setTimeout(r, m.header.controlId === 'A' ? 30 : 0));
      seen.push(m.header.controlId);
      return buildAck(m, 'AA');
    },
  });
  assert.ok(server.port > 0);
  const client = net.connect({ host: '127.0.0.1', port: server.port });
  const framesP = readFrames(client, 2);
  const mk = (id: string): string => `MSH|^~\\&|CERNER|HOSP|BILLING|KINETIK|20261105143000||ADT^A04|${id}|P|2.5.1\r`;
  client.write(Buffer.concat([encodeMllp(mk('A')), encodeMllp(mk('B'))]));
  const acks = (await framesP).map(parseHl7);
  assert.deepEqual(seen, ['A', 'B']);
  assert.equal(acks.length, 2);
  assert.deepEqual(acks.map((a) => a.segments[1]!.fields[1]![0]![0]![0]), ['A', 'B']);
  client.destroy();
  await server.close();
});

test('a failing handler is logged and does not kill the server', async () => {
  const logs: string[] = [];
  const server = await startMllpServer({
    port: 0, host: '127.0.0.1', log: (l) => logs.push(l),
    onMessage: async (raw) => { if (raw === 'boom') throw new Error('bad'); return 'MSH|ok\r'; },
  });
  const client = net.connect({ host: '127.0.0.1', port: server.port });
  const framesP = readFrames(client, 1);
  client.write(Buffer.concat([encodeMllp('boom'), encodeMllp('fine')]));
  assert.deepEqual(await framesP, ['MSH|ok\r']);
  assert.ok(logs.some((l) => l.includes('handler failed')));
  client.destroy();
  await server.close();
});

test('close destroys open sockets and resolves', async () => {
  const server = await startMllpServer({ port: 0, host: '127.0.0.1', onMessage: async () => 'x' });
  const client = net.connect({ host: '127.0.0.1', port: server.port });
  client.on('error', () => {});
  await new Promise((r) => client.once('connect', r));
  const closed = new Promise((r) => client.once('close', r));
  await server.close();
  await closed;
});

test('decoder drops an unterminated frame that exceeds the size cap', () => {
  const d = new MllpDecoder();
  d.feed(Buffer.concat([Buffer.from([0x0b]), Buffer.alloc(MAX_FRAME_BYTES, 0x41)]));
  const got = d.feed(Buffer.concat([Buffer.from([0x0b]), Buffer.from('MSH|ok'), Buffer.from([0x1c, 0x0d])]));
  assert.deepEqual(got, ['MSH|ok']);
});
