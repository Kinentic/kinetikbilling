// Minimal Lower Layer Protocol: <VT 0x0B> message <FS 0x1C> <CR 0x0D>.

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

export function encodeMllp(_raw: string): Buffer {
  throw new Error('hl7/mllp not implemented');
}

/** Incremental frame decoder. Feed it chunks; it yields complete messages. */
export class MllpDecoder {
  feed(_chunk: Buffer): string[] {
    throw new Error('hl7/mllp not implemented');
  }
}

export function startMllpServer(_opts: MllpServerOptions): Promise<MllpServer> {
  throw new Error('hl7/mllp not implemented');
}
