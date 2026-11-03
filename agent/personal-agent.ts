/**
 * A small reference Personal Agent (the "User's agent" side of Poppy draft 0.3), used by the demo
 * and the end-to-end tests. It shows what a Poppy personal agent does under the hood:
 *
 *   - publishes a client metadata document and JWKS (spec 4.1)
 *   - keeps one pairwise User ID per Company and a delegated key per User ID (5.1, 5.2)
 *   - signs a fresh Session JWT for every request (5.2)
 *   - discovers a Company and validates poppy.json (section 3)
 *   - shows operation summaries to the human and sends approvals only with their consent (Operations 5-6)
 *
 * It is not a production agent: keys live in memory, and the "user interface" is a callback.
 */
import type { KeyObject } from 'node:crypto';
import { b64u, randomId, sha256 } from '../src/util/b64.ts';
import { generateP256, generateRsa, jwkThumbprint, signEs256, signPs384, type EcJwk } from '../src/poppy/jwt.ts';
import { formatApprovalHeader, type Approval, type Operation } from '../src/poppy/operations.ts';
import { Router, json, startServer, closeServer } from '../src/util/http.ts';

export type Company = {
  base: string;
  identifier: string; // aud for Session JWTs: the issuer, or https://{domain} without one (3.2)
  poppy: Record<string, any>;
  issuer?: string;
  as?: Record<string, any>; // authorization server metadata
};

export type Tokens = { access_token: string; refresh_token?: string; scopes: string[]; expires_at: number };

export type HttpResult = { status: number; headers: Headers; body: any };

type Delegated = { key: KeyObject; jwk: EcJwk; kid: string; delegation: string; exp: number };

export class PersonalAgent {
  clientId = '';
  base = '';
  name: string;
  root = generateP256();
  rootKid: string;
  userIds = new Map<string, string>(); // company identifier -> pairwise User ID
  delegated = new Map<string, Delegated>(); // User ID -> delegated key
  supportsOperations: boolean;
  tokens = new Map<string, Tokens>(); // company identifier -> tokens
  /** Sign the delegations with an RSA key (PS384) instead of the P-256 root key. */
  rsa?: ReturnType<typeof generateRsa>;
  rsaKid?: string;
  private server?: Awaited<ReturnType<typeof startServer>>;

  constructor(opts: { name?: string; supportsOperations?: boolean; ps384?: boolean } = {}) {
    this.name = opts.name ?? 'Haat reference agent';
    this.supportsOperations = opts.supportsOperations ?? true;
    this.rootKid = jwkThumbprint(this.root.publicJwk);
    if (opts.ps384) {
      this.rsa = generateRsa();
      this.rsaKid = jwkThumbprint(this.rsa.publicJwk);
    }
  }

  jwks() {
    return {
      keys: [
        { ...this.root.publicJwk, kid: this.rootKid, alg: 'ES256', use: 'sig' },
        ...(this.rsa ? [{ ...this.rsa.publicJwk, kid: this.rsaKid, alg: 'PS384', use: 'sig' }] : []),
      ],
    };
  }

  /** Serves agent.json and jwks.json on a local port. */
  async start(port = 0): Promise<this> {
    const r = new Router();
    r.on('GET', '/agent.json', () => json(200, this.metadata()));
    r.on('GET', '/jwks.json', () => json(200, this.jwks()));
    this.server = await startServer(r, port);
    this.base = this.server.url;
    this.clientId = `${this.base}/agent.json`;
    return this;
  }

  async stop(): Promise<void> {
    if (this.server) await closeServer(this.server.server);
  }

  metadata() {
    return {
      client_id: this.clientId,
      client_name: this.name,
      jwks_uri: `${this.base}/jwks.json`,
      redirect_uris: [`${this.base}/oauth/callback`],
      token_endpoint_auth_method: 'private_key_jwt',
      ...(this.supportsOperations ? { extensions: { operations: { version: '2' } } } : {}),
    };
  }

  /** Spec section 3: fetch and check poppy.json, then find the Company identifier (3.2). */
  async discover(startUrl: string): Promise<Company> {
    const url = new URL('/.well-known/poppy.json', startUrl);
    const res = await fetch(url, { redirect: 'follow' });
    if (res.status !== 200) throw new Error(`poppy.json: HTTP ${res.status}`);
    const finalUrl = new URL(res.url || url.href);
    if (finalUrl.pathname !== '/.well-known/poppy.json' || finalUrl.search) throw new Error('poppy.json redirected to another path');
    const doc = (await res.json()) as Record<string, any>;
    if (doc.protocol_version !== '0.3') throw new Error(`unsupported protocol_version ${doc.protocol_version}`);
    if (String(doc.organization?.domain).toLowerCase() !== finalUrl.host.toLowerCase()) throw new Error('organization.domain is not the host that served poppy.json');
    const base = `${finalUrl.protocol}//${finalUrl.host}`;
    const domainResource = `https://${finalUrl.host.toLowerCase()}`;
    const prm = await fetch(new URL('/.well-known/oauth-protected-resource', finalUrl));
    if (prm.status === 404) {
      if (doc.auth?.issuer) throw new Error('poppy.json names an issuer but the domain publishes no protected resource metadata');
      return { base, identifier: domainResource, poppy: doc };
    }
    if (prm.status !== 200) throw new Error(`protected resource metadata: HTTP ${prm.status} (no fallback allowed, 3.2)`);
    const meta = (await prm.json()) as { resource?: string; authorization_servers?: string[] };
    if (meta.resource !== domainResource) throw new Error('protected resource metadata names another resource');
    const servers = meta.authorization_servers ?? [];
    if (servers.length === 0) return { base, identifier: domainResource, poppy: doc };
    const issuer = servers.length === 1 ? servers[0]! : doc.auth?.issuer;
    if (!issuer || !servers.includes(issuer)) throw new Error('cannot choose the issuer (3.2)');
    if (doc.auth?.issuer && doc.auth.issuer !== issuer) throw new Error('auth.issuer does not match the protected resource metadata');
    const iu = new URL(issuer);
    const asUrl = `${iu.origin}/.well-known/oauth-authorization-server${iu.pathname === '/' ? '' : iu.pathname}`;
    const as = (await (await fetch(asUrl)).json()) as Record<string, any>;
    // 3.2: issuer must match character for character, and it must vouch for this domain.
    if (as.issuer !== issuer) throw new Error('authorization server metadata issuer mismatch');
    if (!Array.isArray(as.protected_resources) || !as.protected_resources.some((r: string) => r.toLowerCase() === domainResource)) {
      throw new Error('the issuer does not list this domain in protected_resources');
    }
    return { base, identifier: issuer, poppy: doc, issuer, as };
  }

  /** private_key_jwt client assertion (4.1): aud is the issuer as a single string. */
  clientAssertion(company: Company, over: Record<string, unknown> = {}, ps384 = false): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: this.clientId, sub: this.clientId, aud: company.issuer, iat: now, exp: now + 60, jti: randomId('', 16), ...over };
    return ps384 && this.rsa
      ? signPs384({ kid: this.rsaKid, typ: 'JWT' }, claims, this.rsa.privateKey)
      : signEs256({ kid: this.rootKid, typ: 'JWT' }, claims, this.root.privateKey);
  }

  async tokenRequest(company: Company, form: Record<string, string>, assertionOver: Record<string, unknown> = {}, ps384 = false): Promise<HttpResult> {
    const body = new URLSearchParams({
      ...form,
      client_id: this.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: this.clientAssertion(company, assertionOver, ps384),
    });
    const res = await fetch(company.as!.token_endpoint, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  /**
   * Direct Sign-In (4.2). `userInBrowser` stands for the person: it receives the authorization URL
   * and returns the URL the browser was sent back to. Only the person may sign in (5.4).
   */
  async signIn(company: Company, scopes: string[], userInBrowser: (authorizeUrl: string) => Promise<string>): Promise<Tokens> {
    if (!company.as) throw new Error('this Company offers no sign-in');
    const verifier = randomId('', 48);
    const state = randomId('', 12);
    const redirectUri = `${this.base}/oauth/callback`;
    const u = new URL(company.as.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: redirectUri, scope: scopes.join(' '), state,
      code_challenge: b64u(sha256(verifier)), code_challenge_method: 'S256',
    }).toString();
    const back = new URL(await userInBrowser(u.href));
    // RFC 9207 / 4.2: the response must come from the issuer we started with.
    if (back.searchParams.get('iss') !== company.issuer) throw new Error('sign-in response from another issuer');
    if (back.searchParams.get('state') !== state) throw new Error('state mismatch');
    const err = back.searchParams.get('error');
    if (err) throw new Error(`sign-in ended: ${err}`);
    const r = await this.tokenRequest(company, { grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirectUri, code_verifier: verifier });
    if (r.status !== 200) throw new Error(`token exchange failed: ${JSON.stringify(r.body)}`);
    const granted = (r.body.scope ?? scopes.join(' ')).split(' ');
    const t = { access_token: r.body.access_token, refresh_token: r.body.refresh_token, scopes: granted, expires_at: Date.now() + r.body.expires_in * 1000 };
    this.tokens.set(company.identifier, t);
    return t;
  }

  async refresh(company: Company, scope?: string): Promise<HttpResult> {
    const t = this.tokens.get(company.identifier)!;
    const r = await this.tokenRequest(company, { grant_type: 'refresh_token', refresh_token: t.refresh_token!, ...(scope ? { scope } : {}) });
    if (r.status === 200) this.tokens.set(company.identifier, { ...t, access_token: r.body.access_token, expires_at: Date.now() + r.body.expires_in * 1000 });
    return r;
  }

  /** Sign-out (5.5): revoke the refresh token; Sessions continue signed out. */
  async signOut(company: Company): Promise<number> {
    const t = this.tokens.get(company.identifier);
    if (!t) return 200;
    const body = new URLSearchParams({
      token: t.refresh_token!, token_type_hint: 'refresh_token', client_id: this.clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: this.clientAssertion(company),
    });
    const res = await fetch(company.as!.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    this.tokens.delete(company.identifier);
    return res.status;
  }

  userId(company: Company): string {
    let id = this.userIds.get(company.identifier);
    if (!id) {
      id = randomId('usr_', 12); // random, not derived from personal data (5.1)
      this.userIds.set(company.identifier, id);
    }
    return id;
  }

  newSession(): string {
    return randomId('', 16);
  }

  private delegatedKey(userId: string): Delegated {
    const now = Math.floor(Date.now() / 1000);
    const d = this.delegated.get(userId);
    if (d && d.exp - 60 > now) return d;
    const k = generateP256();
    const exp = now + 6 * 3600;
    const claims = { iss: this.clientId, cnf: { jwk: k.publicJwk }, iat: now, exp, jti: randomId('', 16) };
    const delegation = this.rsa
      ? signPs384({ typ: 'pap-delegation+jwt', kid: this.rsaKid }, claims, this.rsa.privateKey)
      : signEs256({ typ: 'pap-delegation+jwt', kid: this.rootKid }, claims, this.root.privateKey);
    const fresh = { key: k.privateKey, jwk: k.publicJwk, kid: jwkThumbprint(k.publicJwk), delegation, exp };
    this.delegated.set(userId, fresh); // one delegated key per User ID (5.2)
    return fresh;
  }

  /** Signs a Session JWT for exactly this request (5.2). */
  sessionJwt(company: Company, sid: string, method: string, url: string, accessToken?: string, over: Record<string, unknown> = {}): string {
    const userId = this.userId(company);
    const d = this.delegatedKey(userId);
    const u = new URL(url);
    return signEs256(
      { typ: 'poppy-session+jwt', kid: d.kid, pap_dlg: d.delegation },
      {
        iss: this.clientId,
        aud: company.identifier,
        sid,
        sub: userId,
        htm: method,
        htu: `${u.protocol}//${u.host}${u.pathname}`,
        iat: Math.floor(Date.now() / 1000),
        jti: randomId('', 16),
        ...(accessToken ? { ath: b64u(sha256(accessToken)) } : {}),
        ...over,
      },
      d.key,
    );
  }

  async call(company: Company, sid: string, method: string, path: string, opts: { body?: unknown; approval?: Approval; headers?: Record<string, string>; signedIn?: boolean } = {}): Promise<HttpResult> {
    const url = new URL(path, company.base).href;
    const token = opts.signedIn ? this.tokens.get(company.identifier)?.access_token : undefined;
    if (opts.signedIn && !token) throw new Error('not signed in to this Company');
    const send = () => {
      // A fresh Session JWT per attempt: each one is single-use (jti) and bound to this request.
      const headers: Record<string, string> = { 'poppy-session': this.sessionJwt(company, sid, method, url, token), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (opts.approval) headers['poppy-approval'] = formatApprovalHeader(opts.approval);
      return fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    };
    let res: Response;
    try {
      res = await send();
    } catch (e) {
      // A pooled connection the Company closed (for example after a restart). Retrying is safe:
      // approvals are at most once on the Company side (Operations section 7).
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code !== 'UND_ERR_SOCKET' && code !== 'ECONNRESET') throw e;
      res = await send();
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  /**
   * Calls an API that may answer `approval_required`. Shows the summary to the human through
   * `ask`, and repeats the identical request with Poppy-Approval only if they say yes.
   */
  async callWithApproval(
    company: Company,
    sid: string,
    method: string,
    path: string,
    body: unknown,
    ask: (op: Operation, company: Company) => Promise<boolean>,
    headers: Record<string, string> = {},
    signedIn = false,
  ): Promise<HttpResult & { approved?: boolean; operation?: Operation }> {
    const first = await this.call(company, sid, method, path, { body, headers, signedIn });
    if (first.status !== 403 || first.body?.error !== 'approval_required') return first;
    const op = first.body.operation as Operation;
    const yes = await ask(op, company);
    if (!yes) return { ...first, approved: false, operation: op };
    let attempt = await this.call(company, sid, method, path, { body, approval: { operation_id: op.operation_id, revision: op.revision }, headers, signedIn });
    for (let i = 0; i < 5 && attempt.status === 503; i++) {
      // Outcome unknown: retry the SAME approval, never ask for a new one (Operations section 7).
      await new Promise((r) => setTimeout(r, Number(attempt.headers.get('retry-after') ?? 1) * 1000));
      attempt = await this.call(company, sid, method, path, { body, approval: { operation_id: op.operation_id, revision: op.revision }, headers, signedIn });
    }
    return { ...attempt, approved: true, operation: op };
  }

  /** Conversation helper: send a message and wait for the Company's reply events (8.3). */
  async say(company: Company, sid: string, conversationId: string | null, message: Record<string, unknown>, wait = 10, signedIn = false): Promise<HttpResult> {
    const msg = { id: randomId('msg_', 12), author: { type: 'agent' }, ...message };
    const path = conversationId ? `/poppy/conversations/${conversationId}/messages?wait=${wait}` : `/poppy/conversations?wait=${wait}`;
    const endpoint = new URL(path, company.base).href;
    return this.call(company, sid, 'POST', endpoint, { body: { message: msg }, signedIn });
  }
}

/**
 * Plays the person's part on the Company's sign-in page, for tests and the demo: loads the page,
 * fills in the phone number and code, ticks scopes, and returns where the browser is sent back to.
 */
export async function personSignsIn(authorizeUrl: string, opts: { phone: string; otp: string; scopes?: string[]; decline?: boolean }): Promise<string> {
  const page = await fetch(authorizeUrl, { redirect: 'manual' });
  if (page.status === 303) return page.headers.get('location')!; // error sent straight back
  const htmlText = await page.text();
  if (page.status !== 200) throw new Error(`sign-in page: HTTP ${page.status}: ${htmlText.slice(0, 200)}`);
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(htmlText)?.[1];
  const offered = [...htmlText.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1]!);
  const cookieHeader = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
  const form = new URLSearchParams({ req: field('req')!, csrf: field('csrf')!, phone: opts.phone, otp: opts.otp, action: opts.decline ? 'decline' : 'approve' });
  for (const sc of opts.scopes ?? offered) form.append('scope', sc);
  const res = await fetch(new URL('/oauth/authorize', authorizeUrl), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader }, body: form });
  if (res.status !== 303) throw new Error(`sign-in did not redirect: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.headers.get('location')!;
}
