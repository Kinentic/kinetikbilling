import net from 'node:net';

// Minimal Lower Layer Protocol: <VT 0x0B> message <FS 0x1C> <CR 0x0D>.
const VT = 0x0b;
const END = Buffer.from([0x1c, 0x0d]);
/** Largest unterminated frame kept in memory; anything bigger is a broken or hostile peer. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface MllpServerOptions {
  port: number;
  host?: string;
  /** Receives the raw message, returns the raw ACK to send back. Must not throw; return an AE/AR ACK instead. */
  onMessage: (raw: string, peer: string) => Promise<string>;
  log?: (line: string) => void;
}

export interface MllpServer {
  readonly port: number;
  close(): Promise<void>;
}

export function encodeMllp(raw: string): Buffer {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(raw, 'utf8'), END]);
}

/** Incremental frame decoder. Feed it chunks; it yields complete messages. */
export class MllpDecoder {
  #buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): string[] {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    if (this.#buf.length > MAX_FRAME_BYTES) this.#buf = Buffer.alloc(0);
    const out: string[] = [];
    for (;;) {
      let start = this.#buf.indexOf(VT);
      if (start === -1) { this.#buf = Buffer.alloc(0); break; }
      const end = this.#buf.indexOf(END, start + 1);
      if (end === -1) {
        // A second start block before any end block means the first frame was truncated.
        const next = this.#buf.indexOf(VT, start + 1);
        if (next !== -1) start = next;
        this.#buf = this.#buf.subarray(start);
        break;
      }
      const next = this.#buf.indexOf(VT, start + 1);
      if (next !== -1 && next < end) { this.#buf = this.#buf.subarray(next); continue; }
      out.push(this.#buf.subarray(start + 1, end).toString('utf8'));
      this.#buf = this.#buf.subarray(end + END.length);
    }
    return out;
  }
}

export function startMllpServer(opts: MllpServerOptions): Promise<MllpServer> {
  const log = opts.log ?? (() => {});
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    const decoder = new MllpDecoder();
    let queue: Promise<void> = Promise.resolve();
    sockets.add(socket);
    socket.on('error', (err) => log(`mllp socket error from ${peer}: ${err.message}`));
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      for (const raw of decoder.feed(chunk)) {
        queue = queue.then(async () => {
          try {
            const ack = await opts.onMessage(raw, peer);
            if (!socket.destroyed) socket.write(encodeMllp(ack));
          } catch (err) {
            log(`mllp handler failed for ${peer}: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }
    });
  });
  server.on('error', (err) => log(`mllp server error: ${err.message}`));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      const addr = server.address() as net.AddressInfo;
      log(`mllp listening on ${addr.address}:${addr.port}`);
      resolve({
        port: addr.port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          for (const s of sockets) s.destroy();
        }),
      });
    });
  });
}
