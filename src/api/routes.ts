// REST surface over the store and the claims engine. Each handler narrows the
// request at the boundary, calls one domain function, and returns plain data.

import type { Store } from '../db/store.ts';
import type { AppConfig } from '../config.ts';
import type {
  ChargeSource, ChargeStatus, ClaimId, ClaimStatus, ClaimType, CoveragePriority, EncounterId, InboundMessageStatus, MessageId, PatientId, Remittance,
} from '../domain/types.ts';
import {
  acknowledge, buildClaim, build837P, closeClaim, loadClaimContext, markSubmitted, parse835, postRemittance, rescrub, reworkClaim,
  type Edi837Controls,
} from '../claims/index.ts';
import { summarizeDocuments } from '../coding/index.ts';
import { addCodingRoutes } from './coding-routes.ts';
import { HttpError, Router, oneOf, requireObject, requireString } from './router.ts';

/** Result of feeding one raw HL7 message through ingest; mirrors ingest's processMessage. */
export interface IngestResult {
  ack: string;
  status: InboundMessageStatus;
  summary?: string;
  error?: string;
}

export interface ApiDeps {
  store: Store;
  config: AppConfig;
  ingest: (raw: string) => IngestResult;
}

/**
 * X12 control numbers must be unique per trading partner. Without a dedicated
 * sequence table they are derived from the clock: 9 digits of milliseconds for
 * the interchange, and the same value for group and transaction set.
 */
const controlsNow = (): Edi837Controls => {
  const n = Date.now() % 1_000_000_000;
  return { interchangeControlNumber: n, groupControlNumber: n, transactionSetControlNumber: n % 1_000_000_000, now: new Date() };
};

const int = (q: URLSearchParams, key: string, fallback: number): number => {
  const v = q.get(key);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${key} must be a non-negative integer`);
  return n;
};

const CLAIM_STATUSES: readonly ClaimStatus[] = ['draft', 'scrub_failed', 'ready', 'submitted', 'rejected', 'accepted', 'paid', 'partially_paid', 'denied', 'closed'];
const CHARGE_STATUSES: readonly ChargeStatus[] = ['unbilled', 'claimed', 'voided'];
const CHARGE_SOURCES: readonly ChargeSource[] = ['cerner_dft', 'coder'];
const MESSAGE_STATUSES: readonly InboundMessageStatus[] = ['accepted', 'error', 'duplicate', 'unsupported'];

const parseRemittance = (body: unknown): Remittance => {
  const o = requireObject(body);
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpError(400, `body.${k} must be integer cents`);
    return v;
  };
  const statusCode = oneOf(String(o.statusCode ?? ''), ['1', '2', '3', '4', '22'] as const, 'body.statusCode');
  if (!statusCode) throw new HttpError(400, 'body.statusCode is required');
  const adjustments = Array.isArray(o.adjustments) ? o.adjustments : [];
  return {
    controlNumber: requireString(body, 'controlNumber'),
    statusCode,
    chargedAmount: num('chargedAmount') as Remittance['chargedAmount'],
    paidAmount: num('paidAmount') as Remittance['paidAmount'],
    patientResponsibility: num('patientResponsibility') as Remittance['patientResponsibility'],
    adjustments: adjustments.map((a: unknown) => {
      const adj = requireObject(a);
      const group = oneOf(String(adj.group ?? ''), ['CO', 'PR', 'OA', 'PI', 'CR'] as const, 'adjustments[].group');
      if (!group || typeof adj.reasonCode !== 'string' || typeof adj.amount !== 'number') throw new HttpError(400, 'adjustments[] need group, reasonCode, integer amount');
      return { group, reasonCode: adj.reasonCode, amount: adj.amount as Remittance['paidAmount'] };
    }),
    ...(typeof o.payerClaimControlNumber === 'string' ? { payerClaimControlNumber: o.payerClaimControlNumber } : {}),
    ...(typeof o.checkNumber === 'string' ? { checkNumber: o.checkNumber } : {}),
    ...(typeof o.paidAt === 'string' ? { paidAt: o.paidAt as Remittance['paidAt'] } : {}),
  };
};

export function buildRouter({ store, config, ingest }: ApiDeps): Router {
  const r = new Router();
  const billing = config.billing;

  r.add('GET', '/health', () => ({ ok: true, messages: store.listMessages(undefined, 1).length >= 0 }));

  // HL7 over HTTP: the same pipeline as MLLP, for interface engines that post instead of connecting.
  r.add('POST', '/hl7', ({ body }) => {
    if (typeof body !== 'string' || body.trim() === '') throw new HttpError(400, 'body must be a raw HL7 message (text/plain)');
    return ingest(body);
  });

  r.add('GET', '/messages', ({ query }) => store.listMessages(oneOf(query.get('status'), MESSAGE_STATUSES, 'status'), int(query, 'limit', 100)));
  r.add('GET', '/messages/:id', ({ params }) => {
    const m = store.getMessage(params.id as MessageId);
    if (!m) throw new HttpError(404, `message ${params.id} not found`);
    return m;
  });
  // Re-runs a stored message through ingest, e.g. after fixing a mapping bug that produced an error status.
  r.add('POST', '/messages/:id/replay', ({ params }) => {
    const m = store.getMessage(params.id as MessageId);
    if (!m) throw new HttpError(404, `message ${params.id} not found`);
    return ingest(m.raw);
  });

  r.add('GET', '/patients', ({ query }) => store.listPatients(int(query, 'limit', 100), int(query, 'offset', 0)));
  r.add('GET', '/patients/:id', ({ params }) => {
    const id = params.id as PatientId;
    const patient = store.getPatient(id);
    if (!patient) throw new HttpError(404, `patient ${id} not found`);
    return { ...patient, encounters: store.listEncounters(id) };
  });

  r.add('GET', '/encounters', ({ query }) => store.listEncounters((query.get('patientId') as PatientId | null) ?? undefined));
  r.add('GET', '/encounters/:id', ({ params }) => {
    const id = params.id as EncounterId;
    const encounter = store.getEncounter(id);
    if (!encounter) throw new HttpError(404, `encounter ${id} not found`);
    return {
      ...encounter,
      coverages: store.listCoverages(id),
      guarantor: store.getGuarantor(id),
      diagnoses: store.listDiagnoses(id),
      charges: store.listCharges({ encounterId: id }),
      claims: store.listClaims({ encounterId: id }),
      documents: summarizeDocuments(store.listDocuments(id)),
      task: store.findTaskByEncounter(id),
    };
  });
  r.add('POST', '/encounters/:id/claims', ({ params, body }) => {
    const o = body === undefined ? {} : requireObject(body);
    const type = oneOf(typeof o.type === 'string' ? o.type : undefined, ['professional', 'institutional'] as const satisfies readonly ClaimType[], 'body.type');
    const priority = o.coveragePriority === undefined ? undefined : oneOf(String(o.coveragePriority), ['1', '2', '3'] as const, 'body.coveragePriority');
    return buildClaim(store, billing, params.id as EncounterId, {
      ...(type ? { type } : {}),
      ...(priority ? { coveragePriority: Number(priority) as CoveragePriority } : {}),
    });
  });

  r.add('GET', '/charges', ({ query }) => store.listCharges({
    ...(query.get('encounterId') ? { encounterId: query.get('encounterId') as EncounterId } : {}),
    ...(query.get('status') ? { status: oneOf(query.get('status'), CHARGE_STATUSES, 'status')! } : {}),
    ...(query.get('source') ? { source: oneOf(query.get('source'), CHARGE_SOURCES, 'source')! } : {}),
  }));

  r.add('GET', '/claims', ({ query }) => store.listClaims({
    ...(query.get('status') ? { status: oneOf(query.get('status'), CLAIM_STATUSES, 'status')! } : {}),
    ...(query.get('encounterId') ? { encounterId: query.get('encounterId') as EncounterId } : {}),
    ...(query.get('patientId') ? { patientId: query.get('patientId') as PatientId } : {}),
  }));
  r.add('GET', '/claims/:id', ({ params }) => {
    const id = params.id as ClaimId;
    const claim = store.getClaim(id);
    if (!claim) throw new HttpError(404, `claim ${id} not found`);
    return { ...claim, charges: store.listCharges({ claimId: id }), events: store.listClaimEvents(id), payments: store.listPayments(id) };
  });
  r.add('GET', '/claims/:id/837p', ({ params }) => build837P(loadClaimContext(store, params.id as ClaimId), billing, controlsNow()));
  r.add('POST', '/claims/:id/rescrub', ({ params }) => rescrub(store, billing, params.id as ClaimId));
  r.add('POST', '/claims/:id/rework', ({ params, body }) => {
    const reason = typeof (body as Record<string, unknown> | undefined)?.reason === 'string' ? (body as Record<string, string>).reason : undefined;
    return reworkClaim(store, billing, params.id as ClaimId, reason);
  });
  // Submission renders the 837P and moves the claim to submitted in one step; the caller forwards the EDI.
  r.add('POST', '/claims/:id/submit', ({ params }) => {
    const id = params.id as ClaimId;
    const controls = controlsNow();
    return store.transaction(() => {
      const edi = build837P(loadClaimContext(store, id), billing, controls);
      const claim = markSubmitted(store, id, controls.now);
      return { claim, interchangeControlNumber: controls.interchangeControlNumber, edi };
    });
  });
  r.add('POST', '/claims/:id/acknowledge', ({ params, body }) => {
    const o = requireObject(body);
    if (typeof o.accepted !== 'boolean') throw new HttpError(400, 'body.accepted must be a boolean');
    return acknowledge(store, params.id as ClaimId, o.accepted, o.detail);
  });
  r.add('POST', '/claims/:id/close', ({ params, body }) => closeClaim(store, params.id as ClaimId, requireString(body, 'reason')));

  // Manual posting of one adjudicated claim, in the same shape the 835 parser produces.
  r.add('POST', '/remittances', ({ body }) => postRemittance(store, parseRemittance(body), 'manual'));
  // A whole 835 interchange (text/plain). Claims we do not know are reported, not fatal.
  r.add('POST', '/remittances/835', ({ body }) => {
    if (typeof body !== 'string') throw new HttpError(400, 'body must be an X12 835 interchange (text/plain)');
    return parse835(body).map((remit) => {
      try {
        const claim = postRemittance(store, remit, '835');
        return { controlNumber: remit.controlNumber, posted: true, status: claim.status };
      } catch (e) {
        return { controlNumber: remit.controlNumber, posted: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  });

  r.add('GET', '/ar/summary', () => store.claimTotalsByStatus());

  addCodingRoutes(r, { store, config });
  return r;
}
