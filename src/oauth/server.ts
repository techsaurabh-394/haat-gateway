/**
 * OAuth authorization server for Poppy sign-in (Personal Agent Protocol draft 0.3, section 4).
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata (issuer = the gateway origin)
 *   GET  /oauth/authorize                          Direct Sign-In page (authorization code + PKCE)
 *   POST /oauth/authorize                          the User approves or declines
 *   POST /oauth/token                              code and refresh_token grants, private_key_jwt
 *   POST /oauth/revoke                             RFC 7009 revocation (sign-out)
 *
 * Accounts are identified by an Indian mobile number. Sending real OTPs needs an SMS provider:
 * plug one into `OtpProvider`. The default provider is a DEVELOPMENT STAND-IN that accepts a fixed
 * code and says so on the page; it refuses to run unless the gateway is in dev mode.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { b64u, randomId, sha256 } from '../util/b64.ts';
import type { Router} from '../util/http.ts';
import { HttpError, cookie, html, json, redirect, type Req, type Res } from '../util/http.ts';
import { decodeJwt, verifyJws } from '../poppy/jwt.ts';
import type { ClientResolver} from '../poppy/session.ts';
import { SessionError } from '../poppy/session.ts';
import { isLoopbackHost } from '../poppy/url-policy.ts';
import type { KV } from '../store/kv.ts';
import type { Address } from '../beckn/types.ts';

export const SCOPES: Record<string, { description: string; hint: { changes: 'none' | 'reversible' | 'irreversible'; personal_data: boolean } }> = {
  'orders:read': { description: 'See your orders and their delivery status', hint: { changes: 'none', personal_data: true } },
  'orders:write': { description: 'Place and cancel orders in your account (each one still needs your approval)', hint: { changes: 'irreversible', personal_data: true } },
  addresses: { description: 'See and change your saved delivery addresses', hint: { changes: 'reversible', personal_data: true } },
};

export type Account = { id: string; phone: string; name?: string; addresses: Array<Address & { id: string; label?: string; contact_name?: string; contact_phone?: string }>; createdAt: string };

export type TokenInfo = { clientId: string; accountId: string; scopes: string[]; exp: number; rtId: string };

export interface OtpProvider {
  /** Text shown under the code field (for example "We sent a code to your phone"). */
  hint(phone: string): string;
  verify(phone: string, code: string): boolean;
}

export class DevOtpProvider implements OtpProvider {
  code: string;
  constructor(code = '123456') {
    this.code = code;
  }
  hint(): string {
    return `Development mode: no SMS is sent. The code is ${this.code}.`;
  }
  verify(_phone: string, code: string): boolean {
    return code === this.code;
  }
}

const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 24 * 3600;
const CODE_TTL = 60;
const ASSERTION_MAX_LIFETIME = 300;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const hash = (t: string) => b64u(createHash('sha256').update(t).digest());

const oauthError = (status: number, error: string, description?: string, headers: Record<string, string> = {}) =>
  new HttpError(status, { error, ...(description ? { error_description: description } : {}) }, { 'cache-control': 'no-store', ...headers });

export type OAuthOptions = {
  issuer: string; // the gateway origin, e.g. https://haat.example.in
  resource: string; // https://{organization.domain}
  organizationName: string;
  kv: KV;
  resolver: ClientResolver;
  otp: OtpProvider;
  secureCookies: boolean;
  now?: () => number;
};

export class OAuthServer {
  o: OAuthOptions;
  now: () => number;

  constructor(o: OAuthOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  metadata() {
    const i = this.o.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/oauth/authorize`,
      token_endpoint: `${i}/oauth/token`,
      revocation_endpoint: `${i}/oauth/revoke`,
      grant_types_supported: ['refresh_token', 'authorization_code'],
      response_types_supported: ['code'],
      scopes_supported: Object.keys(SCOPES),
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['ES256', 'PS384'],
      revocation_endpoint_auth_methods_supported: ['private_key_jwt'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      protected_resources: [this.o.resource],
    };
  }

  routes(r: Router): void {
    r.on('GET', '/.well-known/oauth-authorization-server', () => json(200, this.metadata(), { 'cache-control': 'public, max-age=300' }));
    r.on('GET', '/oauth/authorize', (req) => this.authorizeStart(req));
    r.on('POST', '/oauth/authorize', (req) => this.authorizeFinish(req));
    r.on('POST', '/oauth/token', (req) => this.token(req));
    r.on('POST', '/oauth/revoke', (req) => this.revoke(req));
  }

  // ---------------------------------------------------------------- Direct Sign-In (4.2)

  private redirectUriAllowed(registered: string[] | undefined, uri: string): boolean {
    if (!registered) return false;
    if (registered.includes(uri)) return true;
    // RFC 8252 7.3: loopback redirect URIs match regardless of port.
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) return false;
    return registered.some((r) => {
      try {
        const x = new URL(r);
        return x.protocol === 'http:' && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
      } catch {
        return false;
      }
    });
  }

  private back(redirectUri: string, params: Record<string, string | undefined>): Res {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set('iss', this.o.issuer); // RFC 9207, also on errors (4.2)
    return redirect(u.href);
  }

  private async authorizeStart(req: Req): Promise<Res> {
    const q = req.url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    let meta;
    try {
      meta = await this.o.resolver.client(clientId);
    } catch (e) {
      // Never redirect to an unverified URI: show the error here.
      return errorPage(400, 'This assistant could not be verified', (e as Error).message);
    }
    if (!this.redirectUriAllowed(meta.redirect_uris, redirectUri)) {
      return errorPage(400, 'This sign-in link is not valid', 'The return address is not one the assistant registered.');
    }
    const state = q.get('state') ?? undefined;
    if (q.get('response_type') !== 'code') return this.back(redirectUri, { error: 'unsupported_response_type', state });
    const challenge = q.get('code_challenge');
    if (!challenge || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return this.back(redirectUri, { error: 'invalid_request', error_description: 'PKCE with S256 is required', state });
    }
    const scopes = (q.get('scope') ?? '').split(' ').filter(Boolean);
    if (scopes.length === 0 || scopes.some((s) => !(s in SCOPES))) return this.back(redirectUri, { error: 'invalid_scope', state });
    const reqId = randomId('ar_', 18);
    const csrf = randomId('', 18);
    this.o.kv.set('oauth_req', reqId, { clientId, clientName: meta.client_name ?? clientId, redirectUri, state, challenge, scopes, csrf }, 600);
    return html(200, signInPage({
      org: this.o.organizationName,
      client: meta.client_name ?? new URL(clientId).host,
      clientHost: new URL(clientId).host,
      scopes,
      reqId,
      csrf,
      otpHint: this.o.otp.hint(''),
    }), { 'set-cookie': `haat_csrf=${csrf}; Path=/oauth; Max-Age=600; HttpOnly; SameSite=Strict${this.o.secureCookies ? '; Secure' : ''}` });
  }

  private async authorizeFinish(req: Req): Promise<Res> {
    const form = new URLSearchParams(req.rawBody.toString('utf8'));
    const reqId = form.get('req') ?? '';
    const pending = this.o.kv.get<{ clientId: string; redirectUri: string; state?: string; challenge: string; scopes: string[]; csrf: string }>('oauth_req', reqId);
    if (!pending) return errorPage(400, 'This sign-in has expired', 'Ask your assistant to start again.');
    const csrfCookie = cookie(req.headers, 'haat_csrf');
    if (!csrfCookie || csrfCookie !== form.get('csrf') || csrfCookie !== pending.csrf) return errorPage(400, 'This sign-in could not be confirmed', 'Please start again from your assistant.');
    this.o.kv.delete('oauth_req', reqId); // one use, whatever the outcome
    if (form.get('action') !== 'approve') return this.back(pending.redirectUri, { error: 'access_denied', state: pending.state });
    const approved = form.getAll('scope').filter((s) => pending.scopes.includes(s)); // never more than requested (4.7)
    if (approved.length === 0) return this.back(pending.redirectUri, { error: 'access_denied', state: pending.state });
    const phone = (form.get('phone') ?? '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone) || !this.o.otp.verify(phone, form.get('otp') ?? '')) {
      return errorPage(400, 'The phone number or code is not right', 'Ask your assistant to start the sign-in again.');
    }
    const account = this.findOrCreateAccount(phone);
    const code = randomId('hac_', 24);
    this.o.kv.set('oauth_code', hash(code), { clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge, scopes: approved, accountId: account.id }, CODE_TTL);
    return this.back(pending.redirectUri, { code, state: pending.state });
  }

  findOrCreateAccount(phone: string): Account {
    const id = this.o.kv.get<string>('account_by_phone', phone);
    const existing = id ? this.o.kv.get<Account>('accounts', id) : undefined;
    if (existing) return existing;
    const account: Account = { id: randomId('acct_', 12), phone, addresses: [], createdAt: new Date(this.now()).toISOString() };
    this.saveAccount(account);
    this.o.kv.set('account_by_phone', phone, account.id);
    return account;
  }

  account(id: string): Account | undefined {
    return this.o.kv.get<Account>('accounts', id);
  }

  saveAccount(a: Account): void {
    this.o.kv.set('accounts', a.id, a);
  }

  // ---------------------------------------------------------------- client authentication (4.1)

  private async authenticateClient(form: Record<string, string>): Promise<string> {
    if (form.client_assertion_type !== ASSERTION_TYPE || !form.client_assertion) throw oauthError(401, 'invalid_client', 'private_key_jwt client assertion required');
    let jwt;
    try {
      jwt = decodeJwt(form.client_assertion);
    } catch {
      throw oauthError(401, 'invalid_client', 'client assertion is not a JWT');
    }
    const p = jwt.payload;
    const clientId = p.iss;
    if (typeof clientId !== 'string' || p.sub !== clientId) throw oauthError(401, 'invalid_client', 'iss and sub must both be the client_id');
    if (form.client_id !== undefined && form.client_id !== clientId) throw oauthError(401, 'invalid_client', 'client_id does not match the assertion');
    // 4.1: aud MUST be the issuer, as a single string, compared character for character.
    if (p.aud !== this.o.issuer) throw oauthError(401, 'invalid_client', 'aud must be the issuer');
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof p.exp !== 'number' || p.exp <= nowSec) throw oauthError(401, 'invalid_client', 'assertion expired or without exp');
    if (typeof p.iat !== 'number' || p.iat > nowSec + 30) throw oauthError(401, 'invalid_client', 'assertion iat missing or in the future');
    if (p.exp - p.iat > ASSERTION_MAX_LIFETIME) throw oauthError(401, 'invalid_client', 'assertion lifetime too long');
    if (typeof p.jti !== 'string' || p.jti.length < 8) throw oauthError(401, 'invalid_client', 'assertion jti missing');
    if (jwt.header.alg !== 'ES256' && jwt.header.alg !== 'PS384') throw oauthError(401, 'invalid_client', 'alg must be ES256 or PS384');
    let meta;
    try {
      meta = await this.o.resolver.client(clientId);
    } catch (e) {
      throw oauthError(401, 'invalid_client', e instanceof SessionError ? e.message : 'client metadata unavailable');
    }
    let keys = await this.o.resolver.keys(meta);
    let key = keys.find((k) => k.kid === jwt.header.kid);
    if (!key) {
      keys = await this.o.resolver.keys(meta, true);
      key = keys.find((k) => k.kid === jwt.header.kid);
    }
    if (!key || !verifyJws(jwt, key)) throw oauthError(401, 'invalid_client', 'assertion signature does not verify');
    const jtiKey = `${clientId} ${p.jti}`;
    if (this.o.kv.get('assertion_jti', jtiKey)) throw oauthError(401, 'invalid_client', 'assertion jti already used');
    this.o.kv.set('assertion_jti', jtiKey, 1, ASSERTION_MAX_LIFETIME + 60);
    return clientId;
  }

  // ---------------------------------------------------------------- token endpoint (4.4, 4.7)

  private issue(clientId: string, accountId: string, scopes: string[], rtId: string): { access_token: string; expires_in: number } {
    const at = randomId('hat_', 32);
    this.o.kv.set('oauth_at', hash(at), { clientId, accountId, scopes, exp: this.now() + ACCESS_TTL * 1000, rtId } satisfies TokenInfo, ACCESS_TTL);
    const list = this.o.kv.get<string[]>('oauth_rt_at', rtId) ?? [];
    list.push(hash(at));
    this.o.kv.set('oauth_rt_at', rtId, list.slice(-200), REFRESH_TTL);
    return { access_token: at, expires_in: ACCESS_TTL };
  }

  private async token(req: Req): Promise<Res> {
    const form = (req.body ?? {}) as Record<string, string>;
    const clientId = await this.authenticateClient(form);
    if (form.grant_type === 'authorization_code') {
      const key = hash(form.code ?? '');
      const code = this.o.kv.get<{ clientId: string; redirectUri: string; challenge: string; scopes: string[]; accountId: string; used?: boolean }>('oauth_code', key);
      if (!code) throw oauthError(400, 'invalid_grant', 'code unknown, used or expired');
      this.o.kv.delete('oauth_code', key); // one-time
      if (code.clientId !== clientId) throw oauthError(400, 'invalid_grant', 'code was issued to another client');
      if (form.redirect_uri !== code.redirectUri) throw oauthError(400, 'invalid_grant', 'redirect_uri does not match');
      const verifier = form.code_verifier ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw oauthError(400, 'invalid_grant', 'code_verifier missing or malformed');
      const expect = Buffer.from(b64u(sha256(verifier)));
      const got = Buffer.from(code.challenge);
      if (expect.length !== got.length || !timingSafeEqual(expect, got)) throw oauthError(400, 'invalid_grant', 'PKCE verification failed');
      const rt = randomId('hrt_', 32);
      const rtId = randomId('rt_', 12);
      this.o.kv.set('oauth_rt', hash(rt), { id: rtId, clientId, accountId: code.accountId, scopes: code.scopes }, REFRESH_TTL);
      const at = this.issue(clientId, code.accountId, code.scopes, rtId);
      return json(200, { ...at, token_type: 'Bearer', refresh_token: rt, scope: code.scopes.join(' ') }, { 'cache-control': 'no-store', pragma: 'no-cache' });
    }
    if (form.grant_type === 'refresh_token') {
      const rec = this.o.kv.get<{ id: string; clientId: string; accountId: string; scopes: string[] }>('oauth_rt', hash(form.refresh_token ?? ''));
      if (!rec || rec.clientId !== clientId) throw oauthError(400, 'invalid_grant', 'refresh token unknown, revoked or issued to another client');
      let scopes = rec.scopes;
      if (form.scope !== undefined) {
        const asked = form.scope.split(' ').filter(Boolean);
        if (asked.length === 0 || asked.some((s) => !rec.scopes.includes(s))) throw oauthError(400, 'invalid_scope', 'can only narrow the granted scopes');
        scopes = asked;
      }
      const at = this.issue(clientId, rec.accountId, scopes, rec.id);
      // 4.7: leave scope out only when exactly what was requested was granted.
      return json(200, { ...at, token_type: 'Bearer', ...(form.scope !== undefined ? {} : { scope: scopes.join(' ') }) }, { 'cache-control': 'no-store', pragma: 'no-cache' });
    }
    throw oauthError(400, 'unsupported_grant_type');
  }

  // ---------------------------------------------------------------- revocation (4.6)

  private async revoke(req: Req): Promise<Res> {
    const form = (req.body ?? {}) as Record<string, string>;
    const clientId = await this.authenticateClient(form);
    const token = form.token ?? '';
    const rtKey = hash(token);
    const rec = this.o.kv.get<{ id: string; clientId: string }>('oauth_rt', rtKey);
    if (rec && rec.clientId === clientId) {
      this.o.kv.delete('oauth_rt', rtKey);
      for (const at of this.o.kv.get<string[]>('oauth_rt_at', rec.id) ?? []) this.o.kv.delete('oauth_at', at);
      this.o.kv.delete('oauth_rt_at', rec.id);
    } else {
      const at = this.o.kv.get<TokenInfo>('oauth_at', rtKey);
      if (at && at.clientId === clientId) this.o.kv.delete('oauth_at', rtKey);
    }
    return { status: 200, text: '', headers: { 'cache-control': 'no-store' } }; // RFC 7009: 200 even for unknown tokens
  }

  // ---------------------------------------------------------------- resource side (4.5, 7)

  /** Validates a Bearer access token. Throws 401 invalid_token (in WWW-Authenticate) if invalid. */
  accessToken(authorization: string | undefined): (TokenInfo & { token: string }) | null {
    if (!authorization) return null;
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization);
    const info = m ? this.o.kv.get<TokenInfo>('oauth_at', hash(m[1]!)) : undefined;
    if (!m || !info || info.exp <= this.now()) {
      throw new HttpError(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
    }
    return { ...info, token: m[1]! };
  }
}

/** 401 for "needs the account, no token" (no error code), 403 insufficient_scope otherwise (section 7). */
export function requireScope(token: TokenInfo | null, scope: string): TokenInfo {
  if (!token) throw new HttpError(401, { error_description: 'sign-in needed', scope }, { 'www-authenticate': `Bearer scope="${scope}"` });
  if (!token.scopes.includes(scope)) throw new HttpError(403, { error: 'insufficient_scope', scope }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}"` });
  return token;
}

// ---------------------------------------------------------------- pages

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#fff;--ink:#1c2033;--muted:#5b6178;--line:#c9cee0;--indigo:#26346f;--marigold:#efa00b;--card:#f3f5fb}
@media (prefers-color-scheme:dark){:root{--bg:#141831;--ink:#e9ecf7;--muted:#a6acc6;--line:#3a4170;--indigo:#8fa2ec;--marigold:#f5b437;--card:#1e2344}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "Segoe UI","Noto Sans","Noto Sans Devanagari",Arial,sans-serif}
main{max-width:30rem;margin:0 auto;padding:2.5rem 1.25rem}
h1{font:600 1.6rem/1.25 "Iowan Old Style",Georgia,serif;margin:0 0 .5rem}
.toran{height:6px;border-radius:3px;background:repeating-linear-gradient(90deg,var(--marigold) 0 14px,transparent 14px 18px);margin-bottom:1.5rem}
p{color:var(--muted);margin:.25rem 0 1rem}fieldset{border:1px solid var(--line);border-radius:12px;padding:.75rem 1rem;margin:0 0 1rem;background:var(--card)}
legend{font-weight:600;padding:0 .25rem}label{display:block;margin:.4rem 0}
input[type=tel],input[type=text]{width:100%;padding:.6rem .7rem;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--ink)}
input:focus-visible,button:focus-visible{outline:3px solid var(--marigold);outline-offset:2px}
.small{font-size:.875rem;color:var(--muted)}.row{display:flex;gap:.75rem;margin-top:1.25rem}
button{flex:1;padding:.7rem;border-radius:10px;font:600 1rem inherit;cursor:pointer;border:1px solid var(--indigo)}
.yes{background:var(--indigo);color:var(--bg)}.no{background:transparent;color:var(--ink)}`;

function signInPage(v: { org: string; client: string; clientHost: string; scopes: string[]; reqId: string; csrf: string; otpHint: string }): string {
  const scopeRows = v.scopes
    .map((s) => `<label><input type="checkbox" name="scope" value="${esc(s)}" checked> ${esc(SCOPES[s]!.description)}</label>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to ${esc(v.org)}</title><style>${PAGE_CSS}</style></head>
<body><main><div class="toran" aria-hidden="true"></div>
<h1>Let ${esc(v.client)} use your ${esc(v.org)} account?</h1>
<p>${esc(v.client)} (${esc(v.clientHost)}) is asking to act for you. Every order it places will still need your approval.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(v.reqId)}"><input type="hidden" name="csrf" value="${esc(v.csrf)}">
<fieldset><legend>It can</legend>${scopeRows}<p class="small">Untick anything you don't want to allow.</p></fieldset>
<fieldset><legend>Your mobile number</legend>
<label for="phone">10-digit mobile number</label><input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" pattern="[0-9 +-]{10,15}" required>
<label for="otp">One-time code</label><input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" required>
<p class="small">${esc(v.otpHint)}</p></fieldset>
<div class="row"><button class="no" name="action" value="decline" formnovalidate>Don't allow</button><button class="yes" name="action" value="approve">Allow</button></div>
</form></main></body></html>`;
}

function errorPage(status: number, title: string, detail: string): Res {
  return html(status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main><div class="toran" aria-hidden="true"></div><h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`);
}
