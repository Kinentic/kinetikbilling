// Process configuration, read once from the environment at startup. Every
// value has a development default so `npm start` works on a fresh checkout;
// production deployments set the BILLING_* identifiers to real ones.

import type { BillingProviderConfig } from './claims/config.ts';

export type { BillingProviderConfig };


export interface AppConfig {
  mllp: { port: number; host: string };
  http: { port: number; host: string };
  dbPath: string;
  billing: BillingProviderConfig;
}

const str = (env: NodeJS.ProcessEnv, key: string, fallback: string): string => {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
};

const port = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${key} must be a TCP port, got ${JSON.stringify(raw)}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mllp: { port: port(env, 'MLLP_PORT', 2575), host: str(env, 'MLLP_HOST', '0.0.0.0') },
    http: { port: port(env, 'HTTP_PORT', 8080), host: str(env, 'HTTP_HOST', '127.0.0.1') },
    dbPath: str(env, 'DB_PATH', 'data/kinetik.sqlite'),
    billing: {
      name: str(env, 'BILLING_NAME', 'KINETIK MEDICAL GROUP'),
      npi: str(env, 'BILLING_NPI', '1234567893'),
      taxId: str(env, 'BILLING_TAX_ID', '123456789'),
      taxonomyCode: str(env, 'BILLING_TAXONOMY', '207Q00000X'),
      address: {
        line1: str(env, 'BILLING_ADDRESS_LINE1', '100 MAIN ST'),
        city: str(env, 'BILLING_CITY', 'PORTLAND'),
        state: str(env, 'BILLING_STATE', 'OR'),
        zip: str(env, 'BILLING_ZIP', '97201'),
      },
      submitterId: str(env, 'SUBMITTER_ID', 'KINETIK01'),
      submitterName: str(env, 'SUBMITTER_NAME', 'KINETIK BILLING'),
      contactName: str(env, 'SUBMITTER_CONTACT_NAME', 'BILLING OFFICE'),
      contactPhone: str(env, 'SUBMITTER_CONTACT_PHONE', '5035550100'),
      receiverId: str(env, 'RECEIVER_ID', 'CLEARINGHOUSE'),
      receiverName: str(env, 'RECEIVER_NAME', 'CLEARINGHOUSE'),
    },
  };
}
