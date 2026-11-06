// Process entry point: one SQLite store, an MLLP listener for Cerner, and an
// HTTP API for billing operations. Everything else is wiring-free.

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildRouter } from './api/routes.ts';
import { loadConfig, type AppConfig } from './config.ts';
import { Store } from './db/store.ts';
import { startMllpServer, type MllpServer } from './hl7/index.ts';
import { processMessage } from './ingest/index.ts';

export interface RunningApp {
  mllpPort: number;
  httpPort: number;
  store: Store;
  stop(): Promise<void>;
}

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

export async function startApp(config: AppConfig): Promise<RunningApp> {
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new Store(config.dbPath);

  const mllp: MllpServer = await startMllpServer({
    port: config.mllp.port,
    host: config.mllp.host,
    log,
    onMessage: async (raw, peer) => {
      const result = processMessage(store, raw);
      log(`hl7 from ${peer}: ${result.status}${result.summary ? ` (${result.summary})` : ''}${result.error ? ` error: ${result.error}` : ''}`);
      return result.ack;
    },
  });

  const router = buildRouter({ store, config, ingest: (raw) => processMessage(store, raw) });
  const httpServer = http.createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.http.port, config.http.host, () => { httpServer.off('error', reject); resolve(); });
  });
  const httpPort = (httpServer.address() as { port: number }).port;
  log(`http listening on ${config.http.host}:${httpPort}`);

  return {
    mllpPort: mllp.port,
    httpPort,
    store,
    stop: async () => {
      await mllp.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
      store.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = await startApp(loadConfig());
  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`);
    void app.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
