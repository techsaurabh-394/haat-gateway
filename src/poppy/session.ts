/**
 * Poppy Session header verification — Personal Agent Protocol draft 0.3, sections 4.1, 5.2 and 5.3.
 *
 * Every check here maps to a MUST in the spec. Comments cite the section so reviewers
 * can compare the code with the text: https://personalagentprotocol.org/docs/0.3/spec
 */
import { sha256, b64u, isPoppyId } from '../util/b64.ts';
import { decodeJwt, isPublicP256Jwk, isPublicRsaJwk, jwkThumbprint, verifyEs256, verifyJws, type EcJwk, type PublicJwk } from './jwt.ts';
import { MemoryKV, type KV } from '../store/kv.ts';
import { assertFetchableUrl, type UrlPolicy } from './url-policy.ts';

export type ClientMetadata = {
  client_id: string;
  client_name?: string;
  jwks_uri: string;
  redirect_uris?: string[];
  extensions?: Record<string, { version?: string }>;
};

export type VerifiedSession = {
  clientId: string;
  clientName?: string;
  clientExtensions: Record<string, { version?: string }>;
  sid: string;
  sub: string;
  agentId?: string;
  /** Key for state owned by this Session (signed-out operations). */
  sessionKey: string;
  /** Key for state owned by this User at this Company (orders, conversations). */
  userKey: string;
  isNew: boolean;
};

export class SessionError extends Error {
  readonly code = 'invalid_session';
}

const fail = (why: string): never => {
  throw new SessionError(why);
};

export type FetchJson = (url: string) => Promise<unknown>;

/** Fetches JSON without following redirects (CIMD draft section 5), with a size and time limit. */
export function defaultFetchJson(policy: UrlPolicy): FetchJson {
  return async (url: string) => {
    assertFetchableUrl(url, policy);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) throw new Error(`GET ${url} returned ${res.status}`);
    const text = await res.text();
    if (text.length > 64 * 1024) throw new Error(`GET ${url}: document too large`);
    return JSON.parse(text);
  };
}

type CacheEntry<T> = { value: T; until: number };

/** Resolves a Personal Agent's client metadata document and JWKS (spec 4.1), with a cache. */
export class ClientResolver {
  fetchJson: FetchJson;
  policy: UrlPolicy;
  ttlMs: number;
  now: () => number;
  meta = new Map<string, CacheEntry<ClientMetadata>>();
  jwks = new Map<string, CacheEntry<PublicJwk[]>>();
  /** Recent failures, so a flood of JWTs naming a bad `iss` doesn't make us fetch it again and again. */
  failures = new Map<string, CacheEntry<string>>();

  constructor(opts: { policy: UrlPolicy; fetchJson?: FetchJson; ttlMs?: number; now?: () => number }) {
    this.policy = opts.policy;
    this.fetchJson = opts.fetchJson ?? defaultFetchJson(opts.policy);
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async client(clientId: string): Promise<ClientMetadata> {
    const hit = this.meta.get(clientId);
    if (hit && hit.until > this.now()) return hit.value;
    const failed = this.failures.get(clientId);
    if (failed && failed.until > this.now()) fail(`client metadata recently failed: ${failed.value}`);
    try {
      return await this.loadClient(clientId);
    } catch (e) {
      if (this.failures.size > 10_000) this.failures.clear();
      this.failures.set(clientId, { value: (e as Error).message, until: this.now() + 60_000 });
      throw e;
    }
  }

  private async loadClient(clientId: string): Promise<ClientMetadata> {
    assertFetchableUrl(clientId, this.policy);
    const doc = (await this.fetchJson(clientId)) as Partial<ClientMetadata> | null;
    if (!doc || typeof doc !== 'object') fail('client metadata is not a JSON object');
    // 4.1: client_id MUST equal the URL the document was fetched from.
    if (doc!.client_id !== clientId) fail('client metadata client_id does not match its URL');
    if (typeof doc!.jwks_uri !== 'string') fail('client metadata has no jwks_uri');
    assertFetchableUrl(doc!.jwks_uri!, this.policy);
    // 4.1: jwks_uri MUST be on the same domain as client_id.
    if (new URL(doc!.jwks_uri!).host.toLowerCase() !== new URL(clientId).host.toLowerCase()) {
      fail('jwks_uri is not on the same domain as client_id');
    }
    const value = doc as ClientMetadata;
    this.bound(this.meta);
    this.meta.set(clientId, { value, until: this.now() + this.ttlMs });
    return value;
  }

  private bound<T>(m: Map<string, T>): void {
    if (m.size > 5000) m.clear(); // caches are bounded; a miss just refetches
  }

  async keys(meta: ClientMetadata, forceRefresh = false): Promise<PublicJwk[]> {
    const hit = this.jwks.get(meta.jwks_uri);
    if (!forceRefresh && hit && hit.until > this.now()) return hit.value;
    const doc = (await this.fetchJson(meta.jwks_uri)) as { keys?: unknown[] } | null;
    if (!doc || !Array.isArray(doc.keys)) fail('jwks_uri did not return a key set');
    // Public P-256 keys (ES256) and RSA keys of 2048+ bits (PS384), each with a kid.
    const keys = doc!.keys!.filter((k): k is PublicJwk => (isPublicP256Jwk(k) || isPublicRsaJwk(k)) && typeof (k as PublicJwk).kid === 'string');
    this.bound(this.jwks);
    this.jwks.set(meta.jwks_uri, { value: keys, until: this.now() + this.ttlMs });
    return keys;
  }
}

type SessionRecord = { clientId: string; sid: string; sub: string; agentId?: string; createdAt: number; endedAt?: number; accountId?: string };

export type SessionVerifierOptions = {
  /** The Company identifier: its issuer, or https://{organization.domain} (spec 3.2). Used as `aud`. */
  audience: string;
  resolver: ClientResolver;
  /** Acceptance window for `iat`, seconds (spec 5.3 suggests about one minute). */
  iatWindowSec?: number;
  now?: () => number;
  kv?: KV;
  /** How long a Session is remembered after its last use, seconds (spec 5.5 lets the Company decide). */
  sessionTtlSec?: number;
};

export class SessionVerifier {
  audience: string;
  resolver: ClientResolver;
  iatWindowSec: number;
  now: () => number;
  kv: KV;
  sessionTtlSec: number;

  constructor(opts: SessionVerifierOptions) {
    this.audience = opts.audience;
    this.resolver = opts.resolver;
    this.iatWindowSec = opts.iatWindowSec ?? 60;
    this.now = opts.now ?? Date.now;
    this.kv = opts.kv ?? new MemoryKV();
    this.sessionTtlSec = opts.sessionTtlSec ?? 30 * 24 * 3600;
  }

  /**
   * Verifies a `Poppy-Session` header for one request (spec 5.3).
   * @param htu the request URL without query or fragment, as the Company publishes it.
   * @param accessToken the bearer token on the request, if any.
   * @param tokenClientId the client the access token was issued to (spec 5.3 step 3).
   */
  async verify(header: string | undefined, method: string, htu: string, accessToken?: string, tokenClientId?: string): Promise<VerifiedSession> {
    if (!header) fail('missing Poppy-Session header');
    let jwt;
    try {
      jwt = decodeJwt(header!);
    } catch (e) {
      return fail(`Session JWT: ${(e as Error).message}`);
    }
    const h = jwt.header;
    const p = jwt.payload;
    const nowSec = Math.floor(this.now() / 1000);

    // 5.2 header rules
    if (h.typ !== 'poppy-session+jwt') fail('typ must be poppy-session+jwt');
    if (h.alg !== 'ES256') fail('alg must be ES256');
    if (typeof h.kid !== 'string') fail('kid missing');
    if (typeof h.pap_dlg !== 'string') fail('Session JWT has no delegation (pap_dlg)');

    // 5.2 claims
    if (typeof p.iss !== 'string') fail('iss missing');
    if (p.aud !== this.audience) fail('aud is not this Company');
    if (!isPoppyId(p.sid)) fail('sid missing or malformed');
    if (typeof p.sub !== 'string' || p.sub.length === 0 || p.sub.length > 256) fail('sub missing');
    if (p.agent_id !== undefined && (typeof p.agent_id !== 'string' || p.agent_id.length === 0)) fail('agent_id malformed');
    if (p.htm !== method) fail('htm does not match the request method');
    if (p.htu !== htu) fail('htu does not match the request URL');
    if (typeof p.iat !== 'number' || Math.abs(nowSec - p.iat) > this.iatWindowSec) fail('iat outside the acceptance window');
    if (typeof p.jti !== 'string' || p.jti.length < 8) fail('jti missing');
    // 5.3 step 3
    if (accessToken) {
      if (p.ath !== b64u(sha256(accessToken))) fail('ath does not match the access token');
    } else if (p.ath !== undefined) {
      fail('ath present without an access token');
    }

    // 5.3 step 1: client metadata and keys
    const iss = p.iss as string;
    let meta: ClientMetadata;
    try {
      meta = await this.resolver.client(iss);
    } catch (e) {
      if (e instanceof SessionError) throw e;
      return fail(`could not load client metadata: ${(e as Error).message}`);
    }

    // 5.2 "Delegated keys": verify the delegation, then the Session JWT with the delegated key.
    let dlg;
    try {
      dlg = decodeJwt(h.pap_dlg as string);
    } catch (e) {
      return fail(`delegation: ${(e as Error).message}`);
    }
    if (dlg.header.typ !== 'pap-delegation+jwt') fail('delegation typ must be pap-delegation+jwt');
    if (dlg.header.alg !== 'ES256' && dlg.header.alg !== 'PS384') fail('delegation alg must be ES256 or PS384');
    if (typeof dlg.header.kid !== 'string') fail('delegation kid missing');
    let keys = await this.resolver.keys(meta);
    let rootKey = keys.find((k) => k.kid === dlg.header.kid);
    if (!rootKey) {
      // Key rotation: refetch once before giving up.
      keys = await this.resolver.keys(meta, true);
      rootKey = keys.find((k) => k.kid === dlg.header.kid);
    }
    if (!rootKey) fail('delegation kid not found in jwks_uri');
    if (!verifyJws(dlg, rootKey!)) fail('delegation signature invalid');
    const dp = dlg.payload;
    if (dp.iss !== iss) fail('delegation iss does not match');
    if (typeof dp.iat !== 'number' || typeof dp.exp !== 'number') fail('delegation iat/exp missing');
    if ((dp.exp as number) <= nowSec) fail('delegation expired');
    if ((dp.exp as number) - (dp.iat as number) > 24 * 3600) fail('delegation lifetime exceeds 24 hours');
    const cnf = dp.cnf as { jwk?: unknown } | undefined;
    if (!cnf || !isPublicP256Jwk(cnf.jwk)) fail('delegation cnf.jwk missing or not a public P-256 key');
    const delegated = cnf!.jwk as EcJwk;
    if (h.kid !== jwkThumbprint(delegated)) fail('kid is not the delegated key thumbprint');
    if (!verifyEs256(jwt, delegated)) fail('Session JWT signature invalid');
    if ((p.iat as number) > (dp.exp as number)) fail('Session JWT signed after its delegation expired');

    // 5.3 step 3: the access token must have been issued to the same client.
    if (accessToken && tokenClientId !== iss) fail('access token was issued to another client');

    // 5.3 "Replayed JWTs": a Company MAY reject a reused jti.
    const jtiKey = `${iss} ${p.jti}`;
    if (this.kv.get('jti', jtiKey)) fail('jti replayed');
    this.kv.set('jti', jtiKey, 1, this.iatWindowSec * 2);

    // 5.3 step 4: Session lookup by client_id and sid.
    const sid = p.sid as string;
    const sub = p.sub as string;
    const agentId = p.agent_id as string | undefined;
    const key = `${iss} ${sid}`;
    let rec = this.kv.get<SessionRecord>('sessions', key);
    let isNew = false;
    if (rec) {
      if (rec.endedAt) fail('Session has ended');
      if (rec.sub !== sub || rec.agentId !== agentId) fail('Session User ID or Agent ID changed');
    } else {
      rec = { clientId: iss, sid, sub, agentId, createdAt: nowSec };
      isNew = true;
    }
    this.kv.set('sessions', key, rec, this.sessionTtlSec);
    return {
      clientId: iss,
      clientName: meta.client_name,
      clientExtensions: meta.extensions ?? {},
      sid,
      sub,
      agentId,
      sessionKey: `${iss}|sid:${sid}`,
      userKey: `${iss}|sub:${sub}`,
      isNew,
    };
  }

  /** Ends a Session; later requests with its sid get invalid_session (spec 5.5). */
  end(clientId: string, sid: string): void {
    const key = `${clientId} ${sid}`;
    const rec = this.kv.get<SessionRecord>('sessions', key);
    if (rec) this.kv.set('sessions', key, { ...rec, endedAt: Math.floor(this.now() / 1000) }, this.sessionTtlSec);
  }

  /**
   * Spec 5.4: a Company MAY reject a request whose access token is for a different account than
   * its Session used before. The first account used in a Session is pinned to it.
   */
  bindAccount(clientId: string, sid: string, accountId: string): void {
    const key = `${clientId} ${sid}`;
    const rec = this.kv.get<SessionRecord>('sessions', key);
    if (!rec) return;
    if (rec.accountId && rec.accountId !== accountId) fail('this Session already used another account');
    if (!rec.accountId) this.kv.set('sessions', key, { ...rec, accountId }, this.sessionTtlSec);
  }
}
