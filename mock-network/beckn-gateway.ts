/**
 * A local Beckn gateway (BG). It verifies the buyer app's signature on `/search`, ACKs, and
 * forwards the unchanged body to every seller registered for the domain and city, adding its own
 * `X-Gateway-Authorization` signature. Sellers reply directly to the buyer app.
 */
import { Router, json, startServer } from '../src/util/http.ts';
import type { RegistryClient } from '../src/beckn/registry.ts';
import { createAuthorizationHeader, verifyAuthorizationHeader, type SigningKey } from '../src/beckn/signing.ts';
import { ACK, nack, type BecknEnvelope } from '../src/beckn/types.ts';
import { logger } from '../src/util/log.ts';

const log = logger('mock-bg');

export function becknGatewayRouter(key: SigningKey, registry: RegistryClient): Router {
  const r = new Router();
  r.on('POST', '/search', async (req) => {
    const v = await verifyAuthorizationHeader(req.headers.authorization, req.rawBody, registry.keyLookup());
    if (!v.ok) return json(401, nack('10001', v.reason));
    const env = req.body as BecknEnvelope;
    if (env?.context?.bap_id !== v.subscriberId) return json(401, nack('10001', 'signer is not context.bap_id'));
    const sellers = await registry.lookup({ type: 'BPP', domain: env.context.domain, city: env.context.city });
    const gwAuth = createAuthorizationHeader(key, req.rawBody);
    for (const s of sellers) {
      fetch(`${s.subscriber_url.replace(/\/$/, '')}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: String(req.headers.authorization), 'x-gateway-authorization': gwAuth },
        body: new Uint8Array(req.rawBody),
        signal: AbortSignal.timeout(5000),
      }).catch((e: Error) => log.warn(`forward to ${s.subscriber_id} failed: ${e.message}`));
    }
    return json(200, ACK);
  });
  return r;
}

export function startBecknGateway(key: SigningKey, registry: RegistryClient, port: number) {
  return startServer(becknGatewayRouter(key, registry), port);
}
