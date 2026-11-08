/**
 * Haat gateway: a Personal Agent Protocol "Company" in front of the ONDC / Beckn network.
 *
 *   Personal Agent --Poppy (Session JWT, OAuth sign-in, Operations v2)--> Haat --Beckn (Ed25519)--> ONDC sellers
 */
import type { Server, ServerResponse } from 'node:http';
import { BapClient } from './beckn/bap.ts';
import { ed25519PrivateKeyFromB64 } from './beckn/signing.ts';
import { RegistryClient } from './beckn/registry.ts';
import { CALLBACKS, type BecknCallback } from './beckn/types.ts';
import { Assistant, type AuthContext, type GateContext } from './commerce/assistant.ts';
import { loadPacks } from './commerce/packs.ts';
import { Commerce, CommerceError, validateCart, type Delivery } from './commerce/service.ts';
import { openapi } from './openapi.ts';
import { decryptChallenge, signRequestId, siteVerificationHtml } from './ondc/onboarding.ts';
import { DevOtpProvider, OAuthServer, SCOPES, requireScope, type OtpProvider, type TokenInfo } from './oauth/server.ts';
import { ConversationStore, MAX_WAIT_SEC, conversationError, parseWait, validateIncomingMessage, type Conversation } from './poppy/conversations.ts';
import { ApprovalGate, parseApprovalHeader, type GateResult } from './poppy/operations.ts';
import { ClientResolver, SessionError, SessionVerifier, type FetchJson, type VerifiedSession } from './poppy/session.ts';
import { openStore, StoreFullError, type KV } from './store/kv.ts';
import { randomId } from './util/b64.ts';
import { ApprovalLinks } from './whatsapp/links.ts';
import type { MessageProvider } from './whatsapp/provider.ts';
import { registerApprovalPages, sendApprovalLink, sendResultResponse } from './whatsapp/routes.ts';
import { HttpError, Router, json, startServer, closeServer, type Req, type Res, type TlsOptions } from './util/http.ts';
import { logger } from './util/log.ts';

const log = logger('gateway');

export type GatewayConfig = {
  /** Base URL Personal Agents use, e.g. https://haat.example.in (http://127.0.0.1:8080 in dev). */
  publicUrl: string;
  /** Allow http:// and loopback client metadata URLs, and the development OTP. Never in production. */
  devInsecure: boolean;
  organizationName: string;
  bap: { subscriberId: string; uniqueKeyId: string; privateKeyB64: string; publicKeyB64: string };
  registryUrl: string;
  becknGatewayUrl: string;
  city: string;
  packsDir: string;
  /** SQLite file for durable state. Without it, state is in memory (bounded) and lost on restart. */
  dbPath?: string;
  /** Poppy sign-in (OAuth). Enabled by default. */
  signIn?: { enabled: boolean; otp?: OtpProvider };
  searchWindowMs?: number;
  /** Requests per minute per Personal Agent (spec 5.6). */
  rateLimitPerMin?: number;
  /** Test hook: resolve client metadata without HTTP. */
  fetchJson?: FetchJson;
  performTimeoutMs?: number;
  /** How long a Beckn request waits for the seller's callback, ms (default 6000). */
  becknTimeoutMs?: number;
  /** Where WhatsApp approval messages are sent. Without it the WhatsApp endpoints answer 404. */
  whatsapp?: { provider: MessageProvider };
  /** Pre-opened store (tests share one across restarts). */
  kv?: KV;
  /** Real ONDC: signed v2 registry lookups, and the onboarding endpoints the registry calls. */
  ondc?: {
    registryLookupUrl?: string; // when set, lookups go to the real v2 registry instead of registryUrl/lookup
    onboarding?: { requestId: string; encryptionPrivateKey: string; registryEncryptionPublicKey: string; callbackPath: string };
  };
  /** Bind address (0.0.0.0 in containers). */
  host?: string;
};

export type Gateway = {
  router: Router;
  config: GatewayConfig;
  commerce: Commerce;
  sessions: SessionVerifier;
  gate: ApprovalGate<GateContext>;
  conversations: ConversationStore;
  oauth?: OAuthServer;
  poppyJson: Record<string, unknown>;
  audience: string;
  kv: KV;
  feedback: () => Array<Record<string, unknown>>;
};

type Ctx = { s: VerifiedSession; token: TokenInfo | null; ownerKey: string; userKey: string; accountKey?: string };

export const EXCLUDED_TASKS = (base: string) => ({
  tasks: [
    {
      task: 'Pay for an order in advance (prepaid or UPI before delivery)',
      alternative: { instructions: 'Orders placed through Haat are paid to the seller on delivery, in cash or by UPI. The approval summary shows the amount before anything is ordered.' },
    },
    {
      task: 'Return or exchange a delivered item',
      alternative: { instructions: "Returns are handled by the seller under ONDC's return policy. Contact the seller using the details in the order, or use your buyer app's grievance process." },
    },
    {
      task: 'Change the delivery address of a placed order',
      alternative: {
        instructions: 'Cancel the order while it is not yet out for delivery (this needs the User\'s approval), then place a new one.',
        references: [{ type: 'openapi', url: `${base}/openapi.json`, operation_id: 'cancelOrder' }],
      },
    },
    { task: 'Talk to a person at the seller' },
  ],
});

export function createGateway(config: GatewayConfig): Gateway {
  const base = config.publicUrl.replace(/\/$/, '');
  const host = new URL(base).host.toLowerCase();
  const signIn = config.signIn?.enabled ?? true;
  const resource = `https://${host}`;
  // Spec 3.2: the Company identifier is its issuer when it has one, else https://{organization.domain}.
  const issuer = base;
  const audience = signIn ? issuer : resource;
  const kv = config.kv ?? openStore(config.dbPath);
  const policy = { allowInsecureLoopback: config.devInsecure };
  const resolver = new ClientResolver({ policy, fetchJson: config.fetchJson });
  const sessions = new SessionVerifier({ audience, resolver, kv });
  const bapSigningKey = {
    subscriberId: config.bap.subscriberId,
    uniqueKeyId: config.bap.uniqueKeyId,
    privateKey: ed25519PrivateKeyFromB64(config.bap.privateKeyB64),
    publicKeyB64: config.bap.publicKeyB64,
  };
  const registry = config.ondc?.registryLookupUrl
    ? new RegistryClient(config.ondc.registryLookupUrl, 60 * 60_000, { kind: 'ondc-v2', signer: bapSigningKey })
    : new RegistryClient(config.registryUrl);
  const packs = loadPacks(config.packsDir);
  const bap = new BapClient({
    key: bapSigningKey,
    bapUri: `${base}/beckn`,
    gatewayUrl: config.becknGatewayUrl,
    registry,
    domain: 'ONDC:RET10',
    city: config.city,
    timeoutMs: config.becknTimeoutMs,
  });
  const commerce = new Commerce({ bap, registry, packs, searchWindowMs: config.searchWindowMs, kv });
  const gate = new ApprovalGate<GateContext>({ performTimeoutMs: config.performTimeoutMs, kv });
  const conversations = new ConversationStore(kv);
  // A seller's answer that arrives after we stopped waiting still decides an unknown outcome:
  // an order id settles the operation (approvals replay it), an explicit error releases it.
  bap.onUnmatched = (callback, env) => {
    if (callback !== 'on_confirm') return;
    const late = commerce.lateConfirm(env);
    if (!late?.operationId) return;
    if (late.outcome === 'confirmed') gate.settle(late.operationId, { status: 201, body: commerce.summarizeOrder(late.order) });
    else gate.release(late.operationId);
  };
  if (signIn && !config.signIn?.otp && !config.devInsecure) {
    throw new Error('Sign-in needs a real OtpProvider outside dev mode (the development code must never run in production).');
  }
  const oauth = signIn
    ? new OAuthServer({
        issuer,
        resource,
        organizationName: config.organizationName,
        kv,
        resolver,
        otp: config.signIn?.otp ?? new DevOtpProvider(),
        secureCookies: base.startsWith('https://'),
      })
    : undefined;
  const assistant = new Assistant(commerce, gate, conversations, oauth);
  const processing = new Map<string, Promise<void>>();
  const feedbackLog: Array<Record<string, unknown>> = [];

  const poppyJson: Record<string, unknown> = {
    protocol_version: '0.3',
    organization: { name: config.organizationName, domain: host },
    ...(signIn
      ? {
          auth: {
            issuer,
            scopes: Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, v.description])),
            scope_hints: Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, v.hint])),
          },
        }
      : {}),
    agent: { protocols: [{ type: 'poppy', endpoint: `${base}/poppy/conversations` }] },
    apis: [
      {
        type: 'openapi',
        url: `${base}/openapi.json`,
        description: "Search sellers on the ONDC network near the User, and place, track and cancel orders. Orders need the User's approval.",
      },
    ],
    feedback: { endpoint: `${base}/poppy/feedback` },
    excluded_tasks: { url: `${base}/poppy/excluded-tasks.json` },
    extensions: { operations: { version: '2' } },
  };

  // --- rate limit (spec 5.6), bounded ---
  const buckets = new Map<string, { tokens: number; at: number }>();
  const limit = config.rateLimitPerMin ?? 120;
  const rateLimit = (clientId: string) => {
    const now = Date.now();
    const b = buckets.get(clientId) ?? { tokens: limit, at: now };
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) / 60_000) * limit);
    b.at = now;
    if (b.tokens < 1) throw new HttpError(429, { error: 'rate_limited' }, { 'retry-after': String(Math.ceil((1 - b.tokens) * (60 / limit))) });
    b.tokens -= 1;
    buckets.delete(clientId);
    buckets.set(clientId, b);
    if (buckets.size > 20_000) buckets.delete(buckets.keys().next().value!);
  };

  // --- Session + access token (spec 5.3, 4.5) ---
  const context = async (req: Req): Promise<Ctx> => {
    const auth = req.headers.authorization;
    let token: (TokenInfo & { token: string }) | null = null;
    if (auth) {
      if (!oauth) throw new HttpError(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
      token = oauth.accessToken(auth);
    }
    let s: VerifiedSession;
    try {
      s = await sessions.verify(req.headers['poppy-session'] as string | undefined, req.method, base + req.url.pathname, token?.token, token?.clientId);
      if (token) sessions.bindAccount(s.clientId, s.sid, token.accountId);
    } catch (e) {
      if (e instanceof SessionError) throw new HttpError(400, { error: 'invalid_session', error_description: e.message });
      throw e;
    }
    rateLimit(s.clientId);
    if (!token) return { s, token: null, ownerKey: s.sessionKey, userKey: s.userKey };
    const accountKey = `acct:${token.accountId}`;
    // Guest orders this User placed through this agent move to the account on first signed-in use.
    if (s.isNew || !kv.get('adopted', `${s.userKey}\n${accountKey}`)) {
      commerce.adoptOrders(s.userKey, accountKey);
      kv.set('adopted', `${s.userKey}\n${accountKey}`, 1, 30 * 24 * 3600);
    }
    // Operations returned in a signed-in Session belong to the account (Operations section 3).
    return { s, token, ownerKey: accountKey, userKey: accountKey, accountKey };
  };

  const operationsSupported = (s: VerifiedSession) => s.clientExtensions?.operations?.version === '2';
  const locale = (req: Req) => String(req.headers['accept-language'] ?? '').split(',')[0]?.trim() || undefined;

  const gateResponse = (r: GateResult): Res => {
    if (r.kind === 'approval_required') return json(403, { error: 'approval_required', operation: r.operation });
    if (r.kind === 'in_progress') return json(503, { error: 'operation_in_progress' }, { 'retry-after': String(r.retryAfterSec) });
    return json(r.response.status, r.response.body);
  };

  const guarded = async (fn: () => Promise<Res>): Promise<Res> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CommerceError) return json(e.status, { error: e.code, error_description: e.message });
      if (e instanceof StoreFullError) return json(503, { error: 'temporarily_unavailable', error_description: 'storage is full; try again later' }, { 'retry-after': '60' });
      throw e;
    }
  };

  const requireOperationsApi = (s: VerifiedSession) => {
    if (!operationsSupported(s)) {
      throw new HttpError(403, { error: 'extension_required', extension: 'operations' }, { 'www-authenticate': 'Bearer error="extension_required", extension="operations"' });
    }
  };

  const savedDelivery = (ctx: Ctx, addressId: string): Delivery => {
    const t = requireScope(ctx.token, 'addresses');
    const account = oauth!.account(t.accountId);
    const a = account?.addresses.find((x) => x.id === addressId);
    if (!account || !a) throw new CommerceError('address_not_found', 'no saved address with that id', 404);
    const { id: _id, label: _l, contact_name, contact_phone, ...address } = a;
    return { name: contact_name ?? 'Customer', phone: contact_phone ?? account.phone, address };
  };

  const router = new Router();

  // --- Discovery (section 3) ---
  router.on('GET', '/.well-known/poppy.json', () => json(200, poppyJson, { 'cache-control': 'public, max-age=300' }));
  router.on('GET', '/.well-known/oauth-protected-resource', () =>
    signIn
      ? json(200, { resource, authorization_servers: [issuer], scopes_supported: Object.keys(SCOPES), bearer_methods_supported: ['header'] }, { 'cache-control': 'public, max-age=300' })
      : json(404, { error: 'not_found', error_description: 'no OAuth issuer: signed-out Sessions only' }),
  );
  router.on('GET', '/openapi.json', () => json(200, openapi(base, signIn ? issuer : undefined, !!config.whatsapp), { 'cache-control': 'public, max-age=300' }));
  router.on('GET', '/health', () => json(200, { ok: true, protocol_version: '0.3', packs: [...commerce.packs.keys()], sign_in: signIn, durable: !!config.dbPath }));
  oauth?.routes(router);

  // --- Task coverage (section 9) ---
  router.on('GET', '/poppy/excluded-tasks.json', () => json(200, EXCLUDED_TASKS(base), { 'cache-control': 'public, max-age=300' }));
  router.on('POST', '/poppy/feedback', async (req) => {
    // 9.3: a Company SHOULD verify the Session header on a report. Haat requires it, so every
    // report is attributed to a verified Personal Agent, User and Session.
    const ctx = await context(req);
    const attributed = { client_id: ctx.s.clientId, sid: ctx.s.sid };
    const b = req.body as { task?: unknown; description?: unknown } | undefined;
    if (!b || typeof b.task !== 'string' || !b.task.trim() || b.task.length > 200 || typeof b.description !== 'string' || !b.description.trim() || b.description.length > 2000) {
      throw new HttpError(400, { error: 'invalid_request', error_description: 'task (1-200 characters) and description (1-2000 characters) are required' });
    }
    // 9.3: the text is data, never instructions. It is stored and logged, nothing more.
    feedbackLog.push({ at: new Date().toISOString(), task: b.task, description: b.description, ...attributed });
    if (feedbackLog.length > 1000) feedbackLog.shift();
    log.info(`feedback: ${JSON.stringify(b.task)}`);
    return { status: 202, text: '' };
  });

  // --- WhatsApp approvals: the link goes to the person's verified phone, never to the agent ---
  if (config.whatsapp) {
    const waDeps = { gate, commerce, links: new ApprovalLinks(kv), provider: config.whatsapp.provider, base };
    registerApprovalPages(router, waDeps);
    router.on('POST', '/api/v1/operations/:id/whatsapp', async (req) => {
      const ctx = await context(req);
      requireOperationsApi(ctx.s);
      // Only a signed-in account has a verified phone. The agent cannot choose where it is sent.
      const t = requireScope(ctx.token, 'orders:write');
      const phone = oauth?.account(t.accountId)?.phone;
      if (!phone || !ctx.accountKey) return json(403, { error: 'sign_in_required', error_description: 'WhatsApp approval needs a signed-in account with a verified phone' });
      return sendResultResponse(await sendApprovalLink(waDeps, { operationId: req.params.id!, ownerKey: ctx.ownerKey, userKey: ctx.userKey, phone }));
    });
  }

  // --- API (section 7) ---
  router.on('GET', '/api/v1/search', async (req) => {
    await context(req);
    return guarded(async () => {
      const r = await commerce.search(req.url.searchParams.get('q') ?? '', { city: req.url.searchParams.get('city') ?? undefined });
      return json(200, {
        query: r.query,
        understood: r.terms,
        offers: r.offers.map((o) => ({
          bpp_id: o.bppId, provider_id: o.providerId, provider_name: o.providerName, locality: o.locality,
          item_id: o.itemId, name: o.name, price: o.price.toFixed(2), available: o.available, term: o.term,
        })),
        suggested_basket: r.basket && {
          bpp_id: r.basket.bppId,
          provider_id: r.basket.providerId,
          provider_name: r.basket.providerName,
          items: r.basket.lines.map((l) => ({ id: l.offer.itemId, count: l.count, name: l.offer.name, line_total: l.lineTotal.toFixed(2), for: l.raw, fit: l.fit })),
          missing: r.basket.missing,
          items_total: r.basket.itemsTotal.toFixed(2),
        },
      });
    });
  });

  router.on('POST', '/api/v1/orders', async (req) => {
    const ctx = await context(req);
    requireOperationsApi(ctx.s);
    if (ctx.token) requireScope(ctx.token, 'orders:write');
    return guarded(async () => {
      const raw = { ...((req.body ?? {}) as Record<string, unknown>) };
      if (typeof raw.delivery_address_id === 'string') {
        raw.delivery = savedDelivery(ctx, raw.delivery_address_id);
        delete raw.delivery_address_id;
      }
      const cart = validateCart(raw);
      const r = await gate.handle({
        ownerKey: ctx.ownerKey,
        actionKey: `order:${cart.bpp_id}:${cart.provider_id}`,
        fingerprint: ApprovalGate.fingerprint(cart),
        approval: parseApprovalHeader(req.headers['poppy-approval'] as string | undefined),
        quote: async () => {
          const q = await commerce.quote(cart, locale(req));
          return { summary: q.summary, terms: q.terms, ttlSec: q.ttlSec, context: { kind: 'order', quote: q.context } };
        },
        perform: async (c, operationId) => {
          if (c.kind !== 'order') throw new Error('wrong operation kind');
          const o = await commerce.confirm(ctx.userKey, c.quote, undefined, operationId);
          return { status: 201, body: commerce.summarizeOrder(o) };
        },
      });
      return gateResponse(r);
    });
  });

  router.on('GET', '/api/v1/orders', async (req) => {
    const ctx = await context(req);
    if (ctx.token) requireScope(ctx.token, 'orders:read');
    return json(200, { orders: commerce.ordersOf(ctx.userKey).map((o) => commerce.summarizeOrder(o)) });
  });

  router.on('GET', '/api/v1/orders/:id', async (req) => {
    const ctx = await context(req);
    if (ctx.token) requireScope(ctx.token, 'orders:read');
    return guarded(async () => json(200, commerce.summarizeOrder(await commerce.status(req.params.id!, ctx.userKey))));
  });

  router.on('POST', '/api/v1/orders/:id/cancel', async (req) => {
    const ctx = await context(req);
    requireOperationsApi(ctx.s);
    if (ctx.token) requireScope(ctx.token, 'orders:write');
    return guarded(async () => {
      const id = req.params.id!;
      const order = commerce.owned(id, ctx.userKey);
      const r = await gate.handle({
        ownerKey: ctx.ownerKey,
        actionKey: `cancel:${id}`,
        fingerprint: ApprovalGate.fingerprint({ cancel: id }),
        approval: parseApprovalHeader(req.headers['poppy-approval'] as string | undefined),
        quote: async () => {
          const fresh = await commerce.status(id, ctx.userKey);
          return { ...commerce.cancelQuote(fresh, locale(req)), context: { kind: 'cancel', orderId: id } };
        },
        perform: async () => ({ status: 200, body: commerce.summarizeOrder(await commerce.cancel(commerce.owned(order.id, ctx.userKey))) }),
      });
      return gateResponse(r);
    });
  });

  // --- Account (signed in only) ---
  if (oauth) {
    router.on('GET', '/api/v1/account/addresses', async (req) => {
      const t = requireScope((await context(req)).token, 'addresses');
      return json(200, { addresses: oauth.account(t.accountId)?.addresses ?? [] });
    });
    router.on('POST', '/api/v1/account/addresses', async (req) => {
      const t = requireScope((await context(req)).token, 'addresses');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const a = b.address as Record<string, unknown> | undefined;
      if (!a || typeof a.city !== 'string' || typeof a.state !== 'string' || typeof a.area_code !== 'string' || !/^[1-9]\d{5}$/.test(a.area_code)) {
        throw new HttpError(400, { error: 'invalid_request', error_description: 'address needs city, state and a 6-digit area_code' });
      }
      if (b.contact_phone !== undefined && (typeof b.contact_phone !== 'string' || !/^[6-9]\d{9}$/.test(b.contact_phone))) {
        throw new HttpError(400, { error: 'invalid_request', error_description: 'contact_phone must be a 10-digit Indian mobile number' });
      }
      const account = oauth.account(t.accountId)!;
      if (account.addresses.length >= 20) throw new HttpError(400, { error: 'invalid_request', error_description: 'at most 20 saved addresses' });
      const pick = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).slice(0, 200) : undefined);
      const saved = {
        id: randomId('addr_', 8),
        ...(typeof b.label === 'string' ? { label: b.label.slice(0, 40) } : {}),
        ...(typeof b.contact_name === 'string' ? { contact_name: b.contact_name.slice(0, 80) } : {}),
        ...(typeof b.contact_phone === 'string' ? { contact_phone: b.contact_phone } : {}),
        building: pick('building'), street: pick('street'), locality: pick('locality'),
        city: pick('city')!, state: pick('state')!, area_code: pick('area_code')!,
      };
      account.addresses.push(saved);
      oauth.saveAccount(account);
      return json(201, saved);
    });
    router.on('DELETE', '/api/v1/account/addresses/:id', async (req) => {
      const t = requireScope((await context(req)).token, 'addresses');
      const account = oauth.account(t.accountId)!;
      const before = account.addresses.length;
      account.addresses = account.addresses.filter((x) => x.id !== req.params.id);
      if (account.addresses.length === before) throw new HttpError(404, { error: 'not_found' });
      oauth.saveAccount(account);
      return { status: 204, text: '' };
    });
  }

  // --- Conversations (section 8) ---
  /** 8.2: a conversation belongs to the client + User, and to the account once it used it. */
  const loadConversation = (id: string, ctx: Ctx): Conversation => {
    let c: Conversation;
    try {
      c = conversations.get(id, conversations.ownerOf(id) ?? '');
    } catch {
      throw conversationError(404, 'conversation_not_found');
    }
    const accountKey = c.memory.accountKey as string | undefined;
    if (accountKey) {
      if (ctx.accountKey === accountKey) return c;
      if (!ctx.token && c.ownerKey === ctx.s.userKey) {
        // 8.11 / 5.5: it used the account, so a signed-out request gets a challenge.
        throw new HttpError(401, { error_description: 'this conversation used the account; sign in to continue', scope: 'orders:read' }, { 'www-authenticate': 'Bearer scope="orders:read"' });
      }
      throw conversationError(404, 'conversation_not_found');
    }
    if (c.ownerKey !== ctx.s.userKey) throw conversationError(404, 'conversation_not_found');
    return c;
  };

  // Conversations work for every agent; only ordering needs the Operations extension (spec 3.3), and
  // operations are never sent to an agent that doesn't list it (Operations section 2).
  const authFor = (ctx: Ctx): AuthContext => ({ token: ctx.token, accountKey: ctx.accountKey, userKey: ctx.userKey, operations: operationsSupported(ctx.s) });

  const runAssistant = (c: Conversation, msg: ReturnType<typeof validateIncomingMessage>, auth: AuthContext) => {
    const prev = processing.get(c.id) ?? Promise.resolve();
    const task = prev.then(async () => {
      conversations.setState(c, 'working');
      try {
        await assistant.handle(c, msg, auth);
      } catch (e) {
        log.error('assistant failed', e);
        conversations.companyMessage(c, { text: 'Something went wrong on our side. Please try again.' });
      } finally {
        if (c.status === 'working') conversations.setState(c, 'idle');
      }
    });
    processing.set(c.id, task); // replies stay in message order
    void task.finally(() => {
      if (processing.get(c.id) === task) processing.delete(c.id);
    });
    return task;
  };

  const respondAfterMessage = async (req: Req, c: Conversation, status: number, task: Promise<void>) => {
    const wait = parseWait(req.url.searchParams.get('wait'));
    const cursor = req.url.searchParams.get('cursor') ?? undefined;
    if (cursor) conversations.indexAfter(c, cursor); // validate before waiting
    if (wait > 0) {
      // Hold until the Company Agent has replied (or `wait` passes), then answer like a read (8.3).
      await Promise.race([task, new Promise((r) => setTimeout(r, Math.min(wait, MAX_WAIT_SEC) * 1000))]);
      return json(status, await conversations.read(c, cursor, 0));
    }
    return json(status, { conversation_id: c.id, status: c.status, responder: c.responder });
  };

  router.on('POST', '/poppy/conversations', async (req) => {
    const ctx = await context(req);
    const body = req.body as { message?: unknown; parent_conversation_id?: unknown } | undefined;
    if (body?.parent_conversation_id !== undefined) {
      // 8.10: the parent is checked first (unknown -> conversation_not_found, closed -> conversation_closed).
      if (typeof body.parent_conversation_id !== 'string') throw conversationError(400, 'invalid_request', 'parent_conversation_id must be a string');
      const parent = loadConversation(body.parent_conversation_id, ctx);
      if (parent.status === 'closed') throw conversationError(409, 'conversation_closed');
      // Direct Conversations need a person at the Company; this gateway has none yet.
      throw conversationError(400, 'invalid_request', 'Direct Conversations are not supported by this Company yet');
    }
    const msg = validateIncomingMessage(body?.message);
    parseWait(req.url.searchParams.get('wait'));
    const replay = conversations.replay(ctx.s.userKey, msg);
    if (replay) return json(replay.status, replay.body);
    return guarded(async () => {
      const c = conversations.create(ctx.s.userKey);
      if (ctx.accountKey) {
        c.memory.accountKey = ctx.accountKey;
        conversations.persist(c);
      }
      conversations.addMessage(c, 'user', msg);
      const task = runAssistant(c, msg, authFor(ctx));
      conversations.remember(ctx.s.userKey, msg, c.id, { status: 201, body: { conversation_id: c.id, status: 'working', responder: 'agent' } });
      return respondAfterMessage(req, c, 201, task);
    });
  });

  router.on('POST', '/poppy/conversations/:id/messages', async (req) => {
    const ctx = await context(req);
    const c = loadConversation(req.params.id!, ctx);
    const msg = validateIncomingMessage((req.body as { message?: unknown } | undefined)?.message);
    parseWait(req.url.searchParams.get('wait'));
    const replay = conversations.replay(ctx.s.userKey, msg);
    if (replay) return json(replay.status, replay.body);
    if (c.status === 'closed') throw conversationError(409, 'conversation_closed');
    return guarded(async () => {
      if (ctx.accountKey && !c.memory.accountKey) {
        c.memory.accountKey = ctx.accountKey; // from now on it belongs to the account (8.2)
        conversations.persist(c);
      }
      conversations.addMessage(c, 'user', msg);
      const task = runAssistant(c, msg, authFor(ctx));
      conversations.remember(ctx.s.userKey, msg, c.id, { status: 202, body: { conversation_id: c.id, status: 'working', responder: c.responder } });
      return respondAfterMessage(req, c, 202, task);
    });
  });

  router.on('GET', '/poppy/conversations/:id/events', async (req) => {
    const ctx = await context(req);
    const c = loadConversation(req.params.id!, ctx);
    // 8.6: Last-Event-ID wins over cursor.
    const cursor = (req.headers['last-event-id'] as string | undefined) ?? req.url.searchParams.get('cursor') ?? undefined;
    const wait = parseWait(req.url.searchParams.get('wait'));
    if (String(req.headers.accept ?? '').includes('text/event-stream')) {
      conversations.indexAfter(c, cursor); // invalid cursors fail before the stream starts
      return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' }, stream: (res) => streamEvents(res, c, cursor) };
    }
    return json(200, await conversations.read(c, cursor, wait));
  });

  /** Server-sent events (8.6): backlog after the cursor, then live events, until closed or 60 s. */
  const streamEvents = (res: ServerResponse, c: Conversation, cursor: string | undefined) =>
    new Promise<void>((resolve) => {
      const write = (e: { id: string }) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      for (const e of c.events.slice(conversations.indexAfter(c, cursor))) write(e);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        unsubscribe();
        clearInterval(ping);
        clearTimeout(cap);
        resolve();
      };
      const unsubscribe = conversations.subscribe(c, (e) => {
        write(e);
        if (e.type === 'state' && e.status === 'closed') finish();
      });
      const ping = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      const cap = setTimeout(finish, 60_000); // the Company MAY close a stream at any time (8.6)
      res.on('close', finish);
      if (c.status === 'closed') finish();
    });

  router.on('POST', '/poppy/conversations/:id/handoff', async (req) => {
    const ctx = await context(req);
    const c = loadConversation(req.params.id!, ctx);
    if (c.status === 'closed') throw conversationError(409, 'conversation_closed');
    if (c.status !== 'queued' && c.responder !== 'human') {
      // No staffed support desk behind this gateway yet: queue, then explain and return to idle (8.9).
      conversations.setState(c, 'queued', 'agent');
      conversations.companyMessage(c, {
        text: 'No person is available through this gateway yet. For help with an order, contact the seller using the details in your order, or file a grievance with your buyer app as ONDC requires.',
      });
      conversations.setState(c, 'idle', 'agent');
    }
    return json(202, { conversation_id: c.id, status: c.status, responder: c.responder });
  });

  router.on('POST', '/poppy/conversations/:id/close', async (req) => {
    const ctx = await context(req);
    const c = loadConversation(req.params.id!, ctx);
    conversations.close(c);
    return json(200, { conversation_id: c.id, status: c.status, responder: c.responder });
  });

  // --- ONDC onboarding (registry "Onboarding of Participants") ---
  const ob = config.ondc?.onboarding;
  if (ob) {
    const signed = signRequestId(ob.requestId, config.bap.privateKeyB64);
    router.on('GET', '/ondc-site-verification.html', () => ({ status: 200, text: siteVerificationHtml(signed), headers: { 'content-type': 'text/html; charset=utf-8' } }));
    router.on('POST', `${ob.callbackPath.replace(/\/$/, '')}/on_subscribe`, (req) => {
      const b = req.body as { subscriber_id?: string; challenge?: string } | undefined;
      if (!b || typeof b.challenge !== 'string' || b.subscriber_id !== config.bap.subscriberId) throw new HttpError(400, { error: 'invalid_request' });
      try {
        return json(200, { answer: decryptChallenge(b.challenge, ob.encryptionPrivateKey, ob.registryEncryptionPublicKey) });
      } catch {
        throw new HttpError(400, { error: 'invalid_request', error_description: 'challenge could not be decrypted' });
      }
    });
  }

  // --- Beckn callbacks from sellers ---
  router.on('POST', '/beckn/:callback', async (req) => {
    const cb = req.params.callback as BecknCallback;
    if (!CALLBACKS.includes(cb)) return json(404, { error: 'not_found' });
    const r = await bap.handleCallback(cb, req.rawBody, req.headers.authorization);
    return json(r.status, r.body);
  });

  return { router, config, commerce, sessions, gate, conversations, oauth, poppyJson, audience, kv, feedback: () => [...feedbackLog] };
}

export async function startGateway(
  config: GatewayConfig,
  port: number,
  host = '127.0.0.1',
  tls?: TlsOptions,
): Promise<{ gateway: Gateway; server: Server; url: string; stop: () => Promise<void> }> {
  const gateway = createGateway(config);
  const { server, url } = await startServer(gateway.router, port, config.host ?? host, tls);
  return { gateway, server, url, stop: () => closeServer(server) };
}
