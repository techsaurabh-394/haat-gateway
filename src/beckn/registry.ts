import { createAuthorizationHeader, type SigningKey } from './signing.ts';
/**
 * Network registry client. ONDC participants find each other's signing keys and URLs through the
 * registry `lookup` API. The mock network implements the same request shape (mock-network/registry.ts).
 */
export type Subscriber = {
  subscriber_id: string;
  ukId: string;
  type: 'BAP' | 'BPP' | 'BG';
  subscriber_url: string;
  signing_public_key: string;
  domain?: string;
  city?: string;
  status?: string;
};

export type RegistryMode =
  /** The local mock: POST {url}/lookup, unsigned. */
  | { kind: 'mock' }
  /** ONDC v2: POST to the full lookup URL, signed like any Beckn call (registry docs, "/v2.0/lookup"). */
  | { kind: 'ondc-v2'; signer: SigningKey };

export class RegistryClient {
  url: string;
  cache = new Map<string, { value: Subscriber[]; until: number }>();
  ttlMs: number;
  mode: RegistryMode;

  constructor(url: string, ttlMs = 60_000, mode: RegistryMode = { kind: 'mock' }) {
    this.url = url.replace(/\/$/, '');
    this.ttlMs = ttlMs;
    this.mode = mode;
  }

  async lookup(query: Partial<Pick<Subscriber, 'subscriber_id' | 'ukId' | 'type' | 'domain' | 'city'>>): Promise<Subscriber[]> {
    const key = JSON.stringify(query);
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    let res: Response;
    if (this.mode.kind === 'ondc-v2') {
      const { ukId, ...rest } = query;
      const body = JSON.stringify({ country: 'IND', ...rest, ...(ukId ? { ukid: ukId } : {}) });
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: createAuthorizationHeader(this.mode.signer, body) },
        body,
        signal: AbortSignal.timeout(8000),
      });
    } else {
      res = await fetch(`${this.url}/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(5000),
      });
    }
    if (!res.ok) throw new Error(`registry lookup failed: ${res.status}`);
    const raw = (await res.json()) as Array<Subscriber & { ukid?: string; unique_key_id?: string }>;
    // Responses name the key id differently across registry versions; normalise to ukId.
    const value = (Array.isArray(raw) ? raw : []).map((x) => ({ ...x, ukId: x.ukId ?? x.ukid ?? x.unique_key_id ?? '' }));
    this.cache.set(key, { value, until: Date.now() + this.ttlMs });
    return value;
  }

  /** Key lookup for signature verification. */
  keyLookup() {
    return async (subscriberId: string, ukId: string): Promise<string | null> => {
      const found = await this.lookup({ subscriber_id: subscriberId, ukId });
      const s = found.find((x) => x.subscriber_id === subscriberId && x.ukId === ukId && (x.status ?? 'SUBSCRIBED') === 'SUBSCRIBED');
      return s?.signing_public_key ?? null;
    };
  }
}
