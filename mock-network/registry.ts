/**
 * A local stand-in for the ONDC registry. It answers `POST /lookup` with subscribers matching the
 * query, the same shape RegistryClient expects. Real ONDC registries also sign their responses and
 * require subscription with domain verification; see docs/going-live.md.
 */
import { Router, json, startServer } from '../src/util/http.ts';
import type { Subscriber } from '../src/beckn/registry.ts';

export function registryRouter(subscribers: Subscriber[]): Router {
  const r = new Router();
  r.on('POST', '/lookup', (req) => {
    const q = (req.body ?? {}) as Partial<Subscriber>;
    const out = subscribers.filter((s) =>
      (!q.subscriber_id || s.subscriber_id === q.subscriber_id) &&
      (!q.ukId || s.ukId === q.ukId) &&
      (!q.type || s.type === q.type) &&
      (!q.domain || !s.domain || s.domain === q.domain) &&
      (!q.city || !s.city || s.city === q.city || s.city === '*'),
    );
    return json(200, out);
  });
  r.on('GET', '/subscribers', () => json(200, subscribers));
  return r;
}

export function startRegistry(subscribers: Subscriber[], port: number) {
  return startServer(registryRouter(subscribers), port);
}
