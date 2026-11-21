/**
 * Operator endpoints:
 *   GET /healthz       liveness: the process answers. Open, reveals nothing.
 *   GET /readyz        readiness: the store works. Open, 200 or 503.
 *   GET /metrics       Prometheus text. Needs the operator token.
 *   GET /ops/overview  stuck operations, pending confirms, seller health. Needs the operator token.
 *
 * The token endpoints answer 404 when no operator token is configured (feature off), 401 for a
 * wrong or missing token. The overview never contains owner or user keys, phone numbers, or
 * order contents: only ids, times and reasons an operator needs to chase a stuck order.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Router, Req, Res } from '../util/http.ts';
import { HttpError, json } from '../util/http.ts';
import type { KV } from '../store/kv.ts';
import type { ApprovalGate } from '../poppy/operations.ts';
import type { Commerce } from '../commerce/service.ts';
import type { GateContext } from '../commerce/assistant.ts';
import type { Metrics, SellerStats } from './metrics.ts';

export type OpsDeps = {
  router: Router;
  token?: string;
  kv: KV;
  gate: ApprovalGate<GateContext>;
  commerce: Commerce;
  metrics: Metrics;
  sellers: SellerStats;
  startedAt: number;
};

const digest = (s: string) => createHash('sha256').update(s).digest();

export function tokenOk(expected: string, header: string | undefined): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  return timingSafeEqual(digest(expected), digest(m[1]!)); // equal length digests: no length leak
}

export function registerOps(d: OpsDeps): void {
  const { router, kv, gate, commerce, metrics, sellers } = d;

  router.on('GET', '/healthz', () => json(200, { ok: true, uptime_s: Math.round((Date.now() - d.startedAt) / 1000) }));
  router.on('GET', '/readyz', () => {
    try {
      const probe = `probe-${Date.now()}`;
      kv.set('ops_probe', 'p', probe, 5);
      const ok = kv.get<string>('ops_probe', 'p') === probe;
      kv.delete('ops_probe', 'p');
      return ok ? json(200, { ready: true }) : json(503, { ready: false, reason: 'store read-back failed' });
    } catch {
      return json(503, { ready: false, reason: 'store unavailable' });
    }
  });

  const guard = (req: Req) => {
    if (!d.token) throw new HttpError(404, { error: 'not_found' });
    if (!tokenOk(d.token, req.headers.authorization)) {
      throw new HttpError(401, { error: 'unauthorized', error_description: 'send the operator token as a Bearer token' }, { 'www-authenticate': 'Bearer realm="haat-ops"' });
    }
  };

  const unresolved = () => gate.unresolved(200);
  const pending = () => commerce.pendingConfirms(200);

  // Gauges are read when /metrics is scraped, so they always reflect the store.
  metrics.gauge('haat_operations_unresolved', 'Approved operations whose outcome is still unknown.', () => unresolved().length);
  metrics.gauge('haat_confirms_pending', 'Confirms sent to a seller that has not answered yet.', () => pending().length);
  metrics.gauge('haat_oldest_unresolved_seconds', 'Age of the oldest operation with an unknown outcome.', () => {
    const since = unresolved()[0]?.unknown?.sinceMs;
    return since ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
  });
  metrics.gauge('haat_uptime_seconds', 'Seconds since the gateway started.', () => Math.round((Date.now() - d.startedAt) / 1000));

  router.on('GET', '/metrics', (req): Res => {
    guard(req);
    return { status: 200, text: metrics.render(), headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' } };
  });

  router.on('GET', '/ops/overview', (req): Res => {
    guard(req);
    const now = Date.now();
    return json(200, {
      generated_at: new Date(now).toISOString(),
      uptime_s: Math.round((now - d.startedAt) / 1000),
      unresolved_operations: unresolved().map((o) => ({
        operation_id: o.operationId,
        action: o.actionKey.split(':')[0],
        unknown_since: o.unknown ? new Date(o.unknown.sinceMs).toISOString() : null,
        age_s: o.unknown ? Math.max(0, Math.round((now - o.unknown.sinceMs) / 1000)) : null,
        reason: o.unknown?.reason ?? null,
      })),
      pending_confirms: pending().map((p) => ({
        transaction_id: p.transactionId,
        operation_id: p.operationId ?? null,
        seller: p.bppId,
        seller_name: p.providerName,
        sent_at: p.sentAt,
        age_s: Math.max(0, Math.round((now - Date.parse(p.sentAt)) / 1000)),
      })),
      sellers: sellers.snapshot(),
    });
  });
}
