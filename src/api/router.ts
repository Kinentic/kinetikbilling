// Thin HTTP boundary: match a route, parse the JSON body, hand typed params to
// a handler, serialize its result. Domain errors map to status codes here and
// nowhere else; handlers throw, they never write to the response.

import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** Maps error class names to HTTP statuses so modules stay free of HTTP. router.test.ts checks every exported error class has a row. */
export const STATUS_BY_ERROR_NAME: Record<string, number> = {
  ClaimNotFoundError: 404,
  EncounterNotFoundError: 404,
  ClaimContextError: 404,
  TaskNotFoundError: 404,
  CodeLineNotFoundError: 404,
  QueryNotFoundError: 404,
  InvalidTransitionError: 409,
  InvalidTaskTransitionError: 409,
  TaskNotEditableError: 409,
  TaskAssignedElsewhereError: 409,
  StaleCodeLineError: 409,
  QueryAlreadyAnsweredError: 409,
  NoCoverageError: 409,
  NoUnbilledChargesError: 409,
  Missing837DataError: 422,
  FeeScheduleError: 400,
  Edi835ParseError: 400,
  Hl7ParseError: 400,
  IngestError: 400,
  SyntaxError: 400,
};

export class Router {
  readonly #routes: Route[] = [];

  add(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: Handler): this {
    const keys: string[] = [];
    const source = path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; });
    this.#routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const route = this.#match(req.method ?? 'GET', url.pathname);
      if (!route) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
      const body = await readBody(req);
      const result = await route.handler({ params: route.params, query: url.searchParams, body });
      if (typeof result === 'string') send(res, 200, result, 'text/plain; charset=utf-8');
      else send(res, result === undefined ? 204 : 200, result === undefined ? '' : JSON.stringify(result), 'application/json');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const status = err instanceof HttpError ? err.status : STATUS_BY_ERROR_NAME[err.name] ?? 500;
      const detail = err instanceof HttpError ? err.detail : undefined;
      send(res, status, JSON.stringify({ error: err.message, ...(detail === undefined ? {} : { detail }) }), 'application/json');
    }
  }

  #match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    for (const r of this.#routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] ?? ''); });
      return { handler: r.handler, params };
    }
    return undefined;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  const type = req.headers['content-type'] ?? '';
  return type.includes('application/json') ? JSON.parse(text) : text;
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Narrowing helpers for request bodies; used by routes at the boundary. */
export function requireString(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  if (typeof v !== 'string' || v === '') throw new HttpError(400, `body.${key} must be a non-empty string`);
  return v;
}
export function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  return body as Record<string, unknown>;
}
/** `value` must be one of `allowed`, or absent. */
export const oneOf = <T extends string>(value: string | null | undefined, allowed: readonly T[], label: string): T | undefined => {
  if (value === null || value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new HttpError(400, `${label} must be one of ${allowed.join(', ')}`);
  return value as T;
};
