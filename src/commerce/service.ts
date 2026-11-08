/**
 * The commerce layer: Poppy-facing operations implemented as Beckn/ONDC transactions.
 *
 *   search  -> Beckn search (fan-out through the gateway, many on_search callbacks)
 *   quote   -> Beckn select (price + stock) then init (billing, delivery, payment terms)
 *   confirm -> Beckn confirm (only after the User approved the exact quote)
 *   status  -> Beckn status
 *   cancel  -> Beckn cancel (also needs approval)
 */
import type { BapClient} from '../beckn/bap.ts';
import { BecknError } from '../beckn/bap.ts';
import type { BecknOutcome } from '../beckn/bap.ts';
import type { RegistryClient } from '../beckn/registry.ts';
import type { Address, BecknEnvelope, Order } from '../beckn/types.ts';
import { Lexicon, formatQuantity, measureToBase, type Term } from '../lexicon/normalize.ts';
import { buildBasket, round2, type Basket, type Offer } from './basket.ts';
import type { Pack } from './packs.ts';
import { MemoryKV, type KV } from '../store/kv.ts';
import { OutcomeUnknownError } from '../poppy/operations.ts';
import { randomUUID } from 'node:crypto';

export class CommerceError extends Error {
  code: string;
  status: number;
  /** For Beckn calls: whether the seller may have acted (see BecknOutcome). */
  outcome?: BecknOutcome;
  constructor(code: string, message: string, status = 400, outcome?: BecknOutcome) {
    super(message);
    this.code = code;
    this.status = status;
    if (outcome) this.outcome = outcome;
  }
}

export type Delivery = {
  name: string;
  phone: string;
  address: Address;
  gps?: string;
};

export type CartRequest = {
  bpp_id: string;
  provider_id: string;
  items: Array<{ id: string; count: number }>;
  delivery: Delivery;
};

export type QuoteContext = {
  cart: CartRequest;
  bppUri: string;
  transactionId: string;
  order: Order;
  providerName: string;
  total: string;
};

export type StoredOrder = {
  id: string;
  userKey: string;
  bppId: string;
  bppUri: string;
  transactionId: string;
  providerName: string;
  order: Order;
  createdAt: string;
};

export type SearchResult = {
  query: string;
  terms: Term[];
  offers: Offer[];
  basket: Basket | null;
};

/**
 * Written BEFORE each confirm is sent, keyed by transaction_id, so a late or post-restart
 * on_confirm can be matched to the exact message we sent and to the operation that sent it.
 */
export type PendingConfirm = {
  operationId?: string;
  userKey: string;
  bppId: string;
  bppUri: string;
  messageId: string;
  providerName: string;
  sentAt: string;
};

/** What a late on_confirm proved. */
export type LateConfirm =
  | { operationId?: string; outcome: 'confirmed'; order: StoredOrder }
  | { operationId?: string; outcome: 'rejected'; error: string };

const PENDING_NS = 'confirm_pending';

const PHONE_RE = /^[6-9]\d{9}$/;
const PIN_RE = /^[1-9]\d{5}$/;

export function validateCart(c: unknown): CartRequest {
  const cart = c as CartRequest;
  const bad = (m: string): never => {
    throw new CommerceError('invalid_request', m);
  };
  if (!cart || typeof cart !== 'object') bad('body must be a JSON object');
  if (typeof cart.bpp_id !== 'string' || !cart.bpp_id) bad('bpp_id is required');
  if (typeof cart.provider_id !== 'string' || !cart.provider_id) bad('provider_id is required');
  if (!Array.isArray(cart.items) || cart.items.length === 0 || cart.items.length > 50) bad('items must be a list of 1-50 entries');
  for (const it of cart.items) {
    if (typeof it?.id !== 'string' || !Number.isInteger(it.count) || it.count < 1 || it.count > 100) bad('each item needs an id and an integer count from 1 to 100');
  }
  const d = cart.delivery;
  if (!d || typeof d.name !== 'string' || !d.name.trim()) bad('delivery.name is required');
  if (typeof d.phone !== 'string' || !PHONE_RE.test(d.phone)) bad('delivery.phone must be a 10-digit Indian mobile number');
  const a = d.address;
  if (!a || typeof a.city !== 'string' || typeof a.state !== 'string' || typeof a.area_code !== 'string') bad('delivery.address needs city, state and area_code');
  if (!PIN_RE.test(a.area_code)) bad('delivery.address.area_code must be a 6-digit PIN code');
  // Normalise item order so the same cart always fingerprints the same.
  return { ...cart, items: [...cart.items].sort((x, y) => x.id.localeCompare(y.id)) };
}

const inr = (n: number | string) => `₹${Number(n).toFixed(2)}`;
const maskPhone = (p: string) => `ending ${p.slice(-4)}`;

export class Commerce {
  bap: BapClient;
  registry: RegistryClient;
  packs: Map<string, { pack: Pack; lexicon: Lexicon }>;
  defaultDomain: string;
  kv: KV;
  searchWindowMs: number;
  /** Orders are kept this long after their last update, seconds. */
  orderTtlSec = 180 * 24 * 3600;

  constructor(opts: { bap: BapClient; registry: RegistryClient; packs: Pack[]; defaultDomain?: string; searchWindowMs?: number; kv?: KV }) {
    this.kv = opts.kv ?? new MemoryKV();
    this.bap = opts.bap;
    this.registry = opts.registry;
    this.packs = new Map(opts.packs.map((p) => [p.domain, { pack: p, lexicon: new Lexicon([p.lexicon]) }]));
    this.defaultDomain = opts.defaultDomain ?? 'ONDC:RET10';
    this.searchWindowMs = opts.searchWindowMs ?? 1200;
  }

  pack(domain = this.defaultDomain) {
    const p = this.packs.get(domain);
    if (!p) throw new CommerceError('unsupported_domain', `no domain pack for ${domain}`);
    return p;
  }

  parse(query: string, domain?: string): Term[] {
    return this.pack(domain).lexicon.parse(query);
  }

  async search(query: string, opts: { domain?: string; city?: string } = {}): Promise<SearchResult> {
    if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new CommerceError('invalid_request', 'q must be 1-300 characters');
    const domain = opts.domain ?? this.defaultDomain;
    const terms = this.parse(query, domain).slice(0, 10);
    if (terms.length === 0) throw new CommerceError('invalid_request', 'no products found in the request');
    const responses = await Promise.all(
      terms.map((t) =>
        this.bap
          .request('search', { intent: { item: { descriptor: { name: t.term } }, fulfillment: { type: 'Delivery' } } }, {
            context: { domain, ...(opts.city ? { city: opts.city } : {}) },
            collect: true,
            windowMs: this.searchWindowMs,
          })
          .then((envs) => ({ t, envs })),
      ),
    );
    const offers: Offer[] = [];
    for (const { t, envs } of responses) for (const env of envs) offers.push(...this.offersFrom(env, t.term));
    return { query, terms, offers, basket: buildBasket(terms, offers) };
  }

  private offersFrom(env: BecknEnvelope, term: string): Offer[] {
    const out: Offer[] = [];
    const cat = env.message?.catalog;
    if (!cat || !env.context.bpp_id || !env.context.bpp_uri) return out;
    for (const p of cat['bpp/providers'] ?? []) {
      for (const it of p.items ?? []) {
        const price = Number(it.price?.value);
        if (!Number.isFinite(price) || price <= 0) continue;
        out.push({
          bppId: env.context.bpp_id,
          bppUri: env.context.bpp_uri,
          providerId: p.id,
          providerName: p.descriptor?.name ?? p.id,
          locality: p.locations?.[0]?.address?.locality,
          itemId: it.id,
          name: it.descriptor?.name ?? it.id,
          price,
          measure: measureToBase(it.quantity?.unitized?.measure),
          available: Number(it.quantity?.available?.count ?? 0),
          term,
        });
      }
    }
    return out;
  }

  /** Never trust a client-supplied seller URL: resolve it from the registry (prevents SSRF). */
  async sellerUri(bppId: string, domain: string): Promise<string> {
    const found = await this.registry.lookup({ subscriber_id: bppId, type: 'BPP' });
    const s = found.find((x) => x.subscriber_id === bppId && (!x.domain || x.domain === domain));
    if (!s) throw new CommerceError('unknown_seller', `seller ${bppId} is not in the registry`, 404);
    return s.subscriber_url;
  }

  /** Beckn select + init: the exact terms the User will be asked to approve. */
  async quote(cart: CartRequest, locale: string | undefined, domain = this.defaultDomain): Promise<{ summary: string; terms: Record<string, unknown>; ttlSec: number; context: QuoteContext }> {
    const bppUri = await this.sellerUri(cart.bpp_id, domain);
    const ctx = { domain, bpp_id: cart.bpp_id, bpp_uri: bppUri };
    const items = cart.items.map((i) => ({ id: i.id, quantity: { count: i.count } }));
    const sel = await this.call('select', { order: { provider: { id: cart.provider_id }, items } }, ctx);
    const transactionId = sel.context.transaction_id;
    const quote = sel.message.order?.quote;
    if (!quote) throw new CommerceError('seller_error', 'seller returned no quote', 502);
    const billing = { name: cart.delivery.name, phone: cart.delivery.phone, address: cart.delivery.address };
    const fulfillment = {
      type: 'Delivery' as const,
      end: {
        location: { ...(cart.delivery.gps ? { gps: cart.delivery.gps } : {}), address: cart.delivery.address },
        contact: { phone: cart.delivery.phone },
        person: { name: cart.delivery.name },
      },
    };
    const ini = await this.call('init', { order: { provider: { id: cart.provider_id }, items, billing, fulfillments: [fulfillment] } }, { ...ctx, transaction_id: transactionId });
    const order = ini.message.order;
    if (!order?.quote || !order.payment) throw new CommerceError('seller_error', 'seller returned no payment terms', 502);
    const providerName = sel.message.order?.provider?.descriptor?.name ?? cart.provider_id;
    const lines = order.quote.breakup.map((b) => ({
      id: b['@ondc/org/item_id'],
      kind: b['@ondc/org/title_type'],
      title: b.title,
      count: b['@ondc/org/item_quantity']?.count,
      amount: b.price.value,
    }));
    const total = order.quote.price.value;
    const pay = order.payment;
    const tat = order.fulfillments?.[0]?.['@ondc/org/TAT'];
    const terms = {
      seller: { bpp_id: cart.bpp_id, provider_id: cart.provider_id, name: providerName },
      lines,
      total: { amount: Number(total).toFixed(2), currency: 'INR' },
      payment: { type: pay.type, collected_by: pay.collected_by },
      deliver_to: { name: cart.delivery.name, area_code: cart.delivery.address.area_code, city: cart.delivery.address.city },
      ...(tat ? { delivery_within: tat } : {}),
      cancellable_until: 'out-for-delivery',
    };
    const summary = renderOrderSummary(locale, providerName, lines, total, pay, cart.delivery, tat);
    const pack = this.pack(domain).pack;
    return { summary, terms, ttlSec: pack.quote_ttl_sec, context: { cart, bppUri, transactionId, order, providerName, total } };
  }

  async confirm(userKey: string, q: QuoteContext, domain = this.defaultDomain, operationId?: string): Promise<StoredOrder> {
    const messageId = randomUUID();
    const pending: PendingConfirm = {
      ...(operationId ? { operationId } : {}),
      userKey,
      bppId: q.cart.bpp_id,
      bppUri: q.bppUri,
      messageId,
      providerName: q.providerName,
      sentAt: new Date().toISOString(),
    };
    // Written BEFORE sending, so a late or post-restart on_confirm can be matched to this attempt.
    this.kv.set(PENDING_NS, q.transactionId, pending, this.orderTtlSec);
    let env: BecknEnvelope;
    try {
      env = await this.call('confirm', { order: q.order }, { domain, bpp_id: q.cart.bpp_id, bpp_uri: q.bppUri, transaction_id: q.transactionId, message_id: messageId });
    } catch (e) {
      // Only a proven "no order" frees the approval. Anything else (timeout, reset, 5xx, or an
      // error we do not recognise) may hide an order the seller already created.
      if (e instanceof CommerceError && (e.outcome === 'not_sent' || e.outcome === 'rejected')) {
        this.kv.delete(PENDING_NS, q.transactionId);
        throw e;
      }
      throw new OutcomeUnknownError(`confirm outcome unknown: ${(e as Error).message}`);
    }
    const order = env.message.order;
    // The seller answered without an order id: we cannot tell whether an order exists, so the
    // pending record stays for reconciliation.
    if (!order?.id) throw new OutcomeUnknownError('seller answered confirm without an order id');
    this.kv.delete(PENDING_NS, q.transactionId);
    return this.recordConfirmed(userKey, q.cart.bpp_id, q.bppUri, q.transactionId, q.providerName, order);
  }

  private recordConfirmed(userKey: string, bppId: string, bppUri: string, transactionId: string, providerName: string, order: Order): StoredOrder {
    const stored: StoredOrder = {
      id: order.id!,
      userKey,
      bppId,
      bppUri,
      transactionId,
      providerName,
      order,
      createdAt: new Date().toISOString(),
    };
    this.saveOrder(stored);
    return stored;
  }

  /**
   * Handles an on_confirm that arrived after we stopped waiting (timeout or restart). The BAP has
   * already verified the signature and that the signer is context.bpp_id. It must also answer the
   * exact message we sent, from the seller we sent it to. Returns undefined when it matches nothing.
   */
  lateConfirm(env: BecknEnvelope): LateConfirm | undefined {
    const transactionId = env.context.transaction_id;
    const p = this.kv.get<PendingConfirm>(PENDING_NS, transactionId);
    if (!p || p.messageId !== env.context.message_id || p.bppId !== env.context.bpp_id) return undefined;
    const base = p.operationId ? { operationId: p.operationId } : {};
    if (env.error) {
      this.kv.delete(PENDING_NS, transactionId);
      return { ...base, outcome: 'rejected', error: env.error.message ?? env.error.code ?? 'seller refused confirm' };
    }
    const order = env.message.order;
    if (!order?.id) return undefined; // still no proof either way; keep waiting
    this.kv.delete(PENDING_NS, transactionId);
    const stored = this.recordConfirmed(p.userKey, p.bppId, p.bppUri, transactionId, p.providerName, order);
    return { ...base, outcome: 'confirmed', order: stored };
  }

  /** Confirms still waiting for the seller's answer (for operators). */
  pendingConfirms(limit = 100): Array<{ transactionId: string } & PendingConfirm> {
    return this.kv.list<PendingConfirm>(PENDING_NS, '', limit).map((r) => ({ transactionId: r.key, ...r.value }));
  }

  saveOrder(o: StoredOrder): void {
    // Keyed by seller + order id: order ids are only unique per seller.
    this.kv.set('orders', `${o.bppId}|${o.id}`, o, this.orderTtlSec);
    this.kv.set('order_ids', o.id, `${o.bppId}|${o.id}`, this.orderTtlSec);
    this.kv.set('user_orders', `${o.userKey}\n${o.createdAt}\n${o.bppId}|${o.id}`, `${o.bppId}|${o.id}`, this.orderTtlSec);
  }

  owned(orderId: string, userKey: string): StoredOrder {
    const ref = this.kv.get<string>('order_ids', orderId);
    const o = ref ? this.kv.get<StoredOrder>('orders', ref) : undefined;
    if (!o || o.userKey !== userKey) throw new CommerceError('order_not_found', 'no such order for this user', 404);
    return o;
  }

  ordersOf(userKey: string): StoredOrder[] {
    return this.kv
      .list<string>('user_orders', `${userKey}\n`, 200)
      .map((r) => this.kv.get<StoredOrder>('orders', r.value))
      // Ignore index entries left behind for orders that now belong to someone else.
      .filter((o): o is StoredOrder => !!o && o.userKey === userKey);
  }

  /** Moves a User's orders to an account after sign-in, so they show up across Sessions and agents. */
  adoptOrders(fromUserKey: string, toUserKey: string): void {
    for (const r of this.kv.list<string>('user_orders', `${fromUserKey}\n`, 200)) {
      const o = this.kv.get<StoredOrder>('orders', r.value);
      if (o && o.userKey === fromUserKey) this.saveOrder({ ...o, userKey: toUserKey });
      this.kv.delete('user_orders', r.key); // drop the guest index entry
    }
  }

  async status(orderId: string, userKey: string, domain = this.defaultDomain): Promise<StoredOrder> {
    const o = this.owned(orderId, userKey);
    const env = await this.call('status', { order_id: orderId }, { domain, bpp_id: o.bppId, bpp_uri: o.bppUri, transaction_id: o.transactionId });
    if (env.message.order) o.order = env.message.order;
    this.saveOrder(o);
    return o;
  }

  cancelQuote(o: StoredOrder, locale?: string) {
    const hi = locale?.toLowerCase().startsWith('hi');
    const state = o.order.fulfillments?.[0]?.state?.descriptor.code ?? o.order.state ?? 'unknown';
    const summary = hi
      ? `${o.providerName} का ऑर्डर **${o.id}** रद्द करें। अभी स्थिति: ${state}। भुगतान डिलीवरी पर होना था, इसलिए कोई पैसा नहीं कटेगा। रद्द करने के बाद इसे वापस नहीं किया जा सकता।`
      : `Cancel order **${o.id}** from ${o.providerName}. Current state: ${state}. Payment was due on delivery, so nothing is charged. A cancelled order cannot be restored.`;
    return {
      summary,
      terms: { order_id: o.id, seller: { bpp_id: o.bppId, name: o.providerName }, refund: { amount: '0.00', currency: 'INR' }, reason_id: '001' },
      ttlSec: 300,
    };
  }

  async cancel(o: StoredOrder, domain = this.defaultDomain): Promise<StoredOrder> {
    const env = await this.call('cancel', { order_id: o.id, cancellation_reason_id: '001' }, { domain, bpp_id: o.bppId, bpp_uri: o.bppUri, transaction_id: o.transactionId });
    if (env.message.order) o.order = env.message.order;
    this.saveOrder(o);
    return o;
  }

  private async call(action: 'select' | 'init' | 'confirm' | 'status' | 'cancel', message: object, ctx: { domain: string; bpp_id: string; bpp_uri: string; transaction_id?: string; message_id?: string }): Promise<BecknEnvelope> {
    let envs: BecknEnvelope[];
    try {
      envs = await this.bap.request(action, message, { context: ctx, target: ctx.bpp_uri });
    } catch (e) {
      if (e instanceof BecknError) {
        throw new CommerceError(e.code === 'timeout' ? 'seller_timeout' : 'seller_unreachable', e.message, e.code === 'timeout' ? 504 : 502, e.outcome);
      }
      throw e;
    }
    const env = envs[0]!;
    if (env.error) throw new CommerceError(`seller_${env.error.code}`, env.error.message ?? 'seller returned an error', 409, 'rejected');
    return env;
  }

  summarizeOrder(o: StoredOrder) {
    const f = o.order.fulfillments?.[0];
    return {
      order_id: o.id,
      seller: { bpp_id: o.bppId, name: o.providerName },
      state: o.order.state,
      fulfillment_state: f?.state?.descriptor.code,
      total: { amount: o.order.quote ? Number(o.order.quote.price.value).toFixed(2) : undefined, currency: 'INR' },
      payment: o.order.payment ? { type: o.order.payment.type, collected_by: o.order.payment.collected_by, status: o.order.payment.status } : undefined,
      items: o.order.items,
      created_at: o.createdAt,
    };
  }
}

type Line = { id: string; kind: string; title: string; count?: number; amount: string };

export function renderOrderSummary(
  locale: string | undefined,
  seller: string,
  lines: Line[],
  total: string,
  pay: { type: string; collected_by: string },
  d: Delivery,
  tat?: string,
): string {
  const hi = locale?.toLowerCase().startsWith('hi');
  const items = lines.filter((l) => l.kind === 'item');
  const charges = lines.filter((l) => l.kind !== 'item');
  const onDelivery = pay.type === 'ON-FULFILLMENT';
  const mins = tat ? /PT(\d+)M/.exec(tat)?.[1] : undefined;
  const addr = [d.address.building, d.address.street, d.address.locality, d.address.city].filter(Boolean).join(', ') + ` ${d.address.area_code}`;
  if (hi) {
    return [
      `**${seller}** से ऑर्डर:`,
      ...items.map((l) => `- ${l.count ?? 1} × ${l.title}: ${inr(l.amount)}`),
      ...charges.map((l) => `- ${l.title}: ${inr(l.amount)}`),
      '',
      `**कुल: ${inr(total)}**, ${onDelivery ? 'डिलीवरी पर विक्रेता को भुगतान (नकद या UPI)' : `भुगतान ${pay.collected_by} द्वारा, ऑर्डर के समय`}।`,
      `डिलीवरी: ${d.name}, ${addr}, फ़ोन ${d.phone.slice(-4)} पर खत्म होने वाला।${mins ? ` लगभग ${mins} मिनट में।` : ''}`,
      'डिलीवरी के लिए निकलने से पहले तक रद्द किया जा सकता है।',
    ].join('\n');
  }
  return [
    `Order from **${seller}**:`,
    ...items.map((l) => `- ${l.count ?? 1} × ${l.title}: ${inr(l.amount)}`),
    ...charges.map((l) => `- ${l.title}: ${inr(l.amount)}`),
    '',
    `**Total: ${inr(total)}**, ${onDelivery ? 'paid to the seller on delivery (cash or UPI)' : `collected by the ${pay.collected_by} when you order`}.`,
    `Deliver to ${d.name}, ${addr}, phone ${maskPhone(d.phone)}.${mins ? ` Expected in about ${mins} minutes.` : ''}`,
    'You can cancel until the order is out for delivery.',
  ].join('\n');
}

export function describeBasket(b: Basket, terms: Term[], locale?: string): string {
  const hi = locale?.toLowerCase().startsWith('hi');
  const lines = b.lines.map((l) => {
    const want = terms.find((t) => t.term === l.term)?.quantity;
    const forQty = want ? (hi ? ` (${formatQuantity(want)} के लिए)` : ` (for ${formatQuantity(want)})`) : '';
    return `- ${l.count} × ${l.offer.name}: ${inr(l.lineTotal)}${forQty}`;
  });
  const missing = b.missing.map((m) => `- ${m.raw}: ${hi ? (m.reason === 'not sold here' ? 'यहाँ नहीं मिलता' : 'पर्याप्त स्टॉक नहीं') : m.reason}`);
  if (hi) {
    return [
      `सबसे अच्छा विकल्प: **${b.providerName}**${b.locality ? `, ${b.locality}` : ''}`,
      ...lines,
      `सामान का कुल: ${inr(b.itemsTotal)} (डिलीवरी शुल्क अंतिम कोटेशन में जुड़ेगा)`,
      ...(missing.length ? ['इस विक्रेता के पास नहीं:', ...missing] : []),
    ].join('\n');
  }
  return [
    `Best match: **${b.providerName}**${b.locality ? `, ${b.locality}` : ''}`,
    ...lines,
    `Items total: ${inr(b.itemsTotal)} (delivery charges come with the final quote)`,
    ...(missing.length ? ['Not available from this seller:', ...missing] : []),
  ].join('\n');
}

export { round2 };
