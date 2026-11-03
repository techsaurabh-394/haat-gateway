import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { logger } from './log.ts';

const log = logger('http');
const MAX_BODY = 256 * 1024;

export type Req = {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  body: unknown;
  params: Record<string, string>;
};

export type Res = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown; // serialised as JSON
  text?: string; // sent as-is (takes precedence over body)
  /** Streams the response (server-sent events). Called after the status and headers are written. */
  stream?: (res: ServerResponse) => Promise<void>;
};

export type Handler = (req: Req) => Promise<Res> | Res;

type Route = { method: string; re: RegExp; keys: string[]; handler: Handler };

/** Throw from a handler to return a JSON error response. */
export class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  constructor(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    super(String(body.error ?? status));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Res => ({ status, body, headers });
export const html = (status: number, page: string, headers: Record<string, string> = {}): Res => ({
  status,
  text: page,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...headers,
  },
});
export const redirect = (location: string): Res => ({ status: 303, text: '', headers: { location } });

/** Reads one cookie value from the request. */
export function cookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  for (const part of String(headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export class Router {
  routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = path
      .replace(/[.]/g, '\\.')
      .replace(/\/:([a-zA-Z_]+)/g, (_m, k: string) => {
        keys.push(k);
        return '/([^/]+)';
      });
    this.routes.push({ method, re: new RegExp('^' + pattern + '/?$'), keys, handler });
    return this;
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]!);
      });
      return { route, params };
    }
    return pathMatched ? 'method' : null;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, { error: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export type TlsOptions = { key: string | Buffer; cert: string | Buffer };

export async function startServer(
  router: Router,
  port: number,
  host = '127.0.0.1',
  tls?: TlsOptions,
): Promise<{ server: Server; port: number; url: string }> {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const send = async (r: Res) => {
      if (r.stream) {
        res.writeHead(r.status, { 'cache-control': 'no-store', ...(r.headers ?? {}) });
        try {
          await r.stream(res);
        } finally {
          res.end();
        }
        return;
      }
      const headers: Record<string, string> = { 'cache-control': 'no-store', ...(r.headers ?? {}) };
      let payload = '';
      if (r.text !== undefined) payload = r.text;
      else if (r.body !== undefined) {
        payload = JSON.stringify(r.body);
        headers['content-type'] ??= 'application/json; charset=utf-8';
      }
      res.writeHead(r.status, headers);
      res.end(payload);
    };
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const method = req.method ?? 'GET';
      const found = router.match(method, url.pathname);
      if (found === null) return send(json(404, { error: 'not_found' }));
      if (found === 'method') return send(json(405, { error: 'method_not_allowed' }));
      const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      let body: unknown = undefined;
      const ctype = String(req.headers['content-type'] ?? '');
      if (rawBody.length && ctype.includes('json')) {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return send(json(400, { error: 'invalid_request', error_description: 'body is not valid JSON' }));
        }
      } else if (rawBody.length && ctype.includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
      }
      await send(await found.route.handler({ method, url, headers: req.headers, rawBody, body, params: found.params }));
    } catch (e) {
      if (res.headersSent) {
        log.error('error after headers were sent', e);
        res.end();
        return;
      }
      if (e instanceof HttpError) return send({ status: e.status, body: e.body, headers: e.headers });
      log.error('unhandled error', e);
      await send(json(500, { error: 'server_error' }));
    }
  };
  const server: Server = tls ? (createHttpsServer(tls, handler) as unknown as Server) : createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actual = (server.address() as AddressInfo).port;
  return { server, port: actual, url: `${tls ? 'https' : 'http'}://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}` };
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
