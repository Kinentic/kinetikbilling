import net from 'node:net';
import { readFileSync } from 'node:fs';
import { MllpDecoder, comp, encodeMllp, firstSegment, parseHl7 } from '../src/hl7/index.ts';

const [target, ...files] = process.argv.slice(2);
const [host, portText] = (target ?? '').split(':');
if (!host || !portText || files.length === 0) {
  console.error('usage: node scripts/send-hl7.ts <host:port> <file...>');
  process.exit(2);
}

const socket = net.connect({ host, port: Number(portText) });
const decoder = new MllpDecoder();
const acks: string[] = [];
let wake: (() => void) | undefined;
socket.on('data', (chunk) => { acks.push(...decoder.feed(chunk)); wake?.(); });
socket.on('error', (err) => { console.error(`connection error: ${err.message}`); process.exit(1); });
socket.on('close', () => wake?.());

async function nextAck(): Promise<string | undefined> {
  while (acks.length === 0 && !socket.destroyed) await new Promise<void>((r) => { wake = r; });
  return acks.shift();
}

let failed = false;
for (const file of files) {
  socket.write(encodeMllp(readFileSync(file, 'utf8').replace(/\r?\n/g, '\r')));
  const raw = await nextAck();
  const msa = raw === undefined ? undefined : firstSegment(parseHl7(raw), 'MSA');
  const code = msa ? comp(msa, 1) : 'NO-ACK';
  console.log(`${file}: ${code} ${msa ? comp(msa, 3) : ''}`.trimEnd());
  if (code !== 'AA') failed = true;
}
socket.end();
process.exit(failed ? 1 : 0);
