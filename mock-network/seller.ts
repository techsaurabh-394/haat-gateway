/**
 * A mock ONDC seller app (BPP) for local development and tests. It behaves like a small kirana
 * store on the network: answers search from its catalog, quotes with delivery charges, takes
 * pay-on-delivery orders, moves orders through fulfilment states over time, and allows
 * cancellation until the order is picked up. Every callback is Ed25519-signed.
 */
import { readFileSync } from 'node:fs';
import { Router, json, startServer } from '../src/util/http.ts';
import type { RegistryClient } from '../src/beckn/registry.ts';
import { createAuthorizationHeader, verifyAuthorizationHeader, type SigningKey } from '../src/beckn/signing.ts';
import { ACK, nack, type BecknAction, type BecknEnvelope, type CatalogItem, type Order, type Quote, type QuoteBreakup } from '../src/beckn/types.ts';
import { logger } from '../src/util/log.ts';

const log = logger('mock-seller');

export type SellerFile = {
  subscriber_id: string;
  provider: { id: string; name: string; locality: string; gps: string; area_code: string };
  delivery: { charge: number; free_above: number; packing: number; tat: string };
  order_prefix: string;
  items: Array<{ id: string; name: string; price: number; measure: [string, string]; stock: number; terms: string[] }>;
};

export function loadSeller(path: string): SellerFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SellerFile;
}

type StoredOrder = { order: Order; createdAt: number; bapUri: string; transactionId: string };

const money = (n: number) => ({ currency: 'INR' as const, value: n.toFixed(2) });

export type SellerOptions = {
  key: SigningKey;
  file: SellerFile;
  registry: RegistryClient;
  /** This seller's public URL (subscriber_url). */
  url: string;
  domain?: string;
  /** Delay before each callback, ms. */
  callbackDelayMs?: number;
  /** Seconds per fulfilment stage (Pending -> Packed -> Order-picked-up -> Order-delivered). */
  stageSec?: number;
};

export function sellerRouter(opts: SellerOptions): Router {
  const { file, key, registry } = opts;
  const stock = new Map(file.items.map((i) => [i.id, i.stock]));
  const orders = new Map<string, StoredOrder>();
  let seq = 1000;
  const stageSec = opts.stageSec ?? 20;

  const catalogItem = (i: SellerFile['items'][number]): CatalogItem => ({
    id: i.id,
    descriptor: { name: i.name },
    price: money(i.price),
    quantity: {
      unitized: { measure: { unit: i.measure[0], value: i.measure[1] } },
      available: { count: String(stock.get(i.id) ?? 0) },
      maximum: { count: String(Math.min(20, stock.get(i.id) ?? 0)) },
    },
    '@ondc/org/returnable': false,
    '@ondc/org/cancellable': true,
  });

  const quoteFor = (items: Array<{ id: string; quantity: { count: number } }>): { quote: Quote } | { error: { code: string; message: string } } => {
    const breakup: QuoteBreakup[] = [];
    let itemsTotal = 0;
    for (const it of items) {
      const def = file.items.find((x) => x.id === it.id);
      if (!def) return { error: { code: '40000', message: `item ${it.id} is not sold here` } };
      const count = it.quantity?.count;
      if (!Number.isInteger(count) || count < 1) return { error: { code: '40000', message: `invalid quantity for ${it.id}` } };
      if (count > (stock.get(it.id) ?? 0)) return { error: { code: '40002', message: `${def.name} is out of stock` } };
      const line = def.price * count;
      itemsTotal += line;
      breakup.push({ '@ondc/org/item_id': it.id, '@ondc/org/item_quantity': { count }, '@ondc/org/title_type': 'item', title: def.name, price: money(line) });
    }
    const delivery = itemsTotal >= file.delivery.free_above ? 0 : file.delivery.charge;
    breakup.push({ '@ondc/org/item_id': 'F1', '@ondc/org/title_type': 'delivery', title: delivery === 0 ? 'Delivery (free)' : 'Delivery charges', price: money(delivery) });
    if (file.delivery.packing) breakup.push({ '@ondc/org/item_id': 'F1', '@ondc/org/title_type': 'packing', title: 'Packing charges', price: money(file.delivery.packing) });
    const total = itemsTotal + delivery + file.delivery.packing;
    return { quote: { price: money(total), breakup, ttl: 'PT10M' } };
  };

  const stageOf = (o: StoredOrder): string => {
    if (o.order.state === 'Cancelled') return 'Cancelled';
    const elapsed = (Date.now() - o.createdAt) / 1000;
    if (elapsed < stageSec) return 'Pending';
    if (elapsed < stageSec * 2) return 'Packed';
    if (elapsed < stageSec * 3) return 'Order-picked-up';
    return 'Order-delivered';
  };

  const respond = (action: BecknAction, req: BecknEnvelope, message: object, error?: { code: string; message: string }) => {
    const context = { ...req.context, action: `on_${action}` as const, bpp_id: file.subscriber_id, bpp_uri: opts.url, timestamp: new Date().toISOString() };
    const body = JSON.stringify({ context, message, ...(error ? { error: { type: 'DOMAIN-ERROR', ...error } } : {}) });
    setTimeout(() => {
      fetch(`${req.context.bap_uri.replace(/\/$/, '')}/on_${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: createAuthorizationHeader(key, body) },
        body,
        signal: AbortSignal.timeout(5000),
      }).catch((e: Error) => log.warn(`on_${action} to ${req.context.bap_uri} failed: ${e.message}`));
    }, opts.callbackDelayMs ?? 30);
  };

  const handlers: Record<BecknAction, (env: BecknEnvelope) => void> = {
    search: (env) => {
      const term = env.message.intent?.item?.descriptor?.name?.toLowerCase().trim();
      const items = file.items.filter((i) => !term || i.terms.includes(term) || i.name.toLowerCase().includes(term));
      if (items.length === 0) return; // sellers stay silent when they have nothing to offer
      respond('search', env, {
        catalog: {
          'bpp/descriptor': { name: file.provider.name },
          'bpp/providers': [{
            id: file.provider.id,
            descriptor: { name: file.provider.name },
            locations: [{ id: `${file.provider.id}-L1`, gps: file.provider.gps, address: { locality: file.provider.locality, city: 'Varanasi', area_code: file.provider.area_code } }],
            items: items.map(catalogItem),
          }],
        },
      });
    },
    select: (env) => {
      const order = env.message.order!;
      const q = quoteFor(order.items);
      const provider = { id: file.provider.id, descriptor: { name: file.provider.name } };
      if ('error' in q) return respond('select', env, { order: { provider, items: order.items } }, q.error);
      respond('select', env, { order: { provider, items: order.items, quote: q.quote } });
    },
    init: (env) => {
      const order = env.message.order!;
      const q = quoteFor(order.items);
      if ('error' in q) return respond('init', env, { order }, q.error);
      const fulfillments = (order.fulfillments ?? []).map((f) => ({ ...f, id: 'F1', '@ondc/org/TAT': file.delivery.tat }));
      respond('init', env, {
        order: {
          ...order,
          provider: { id: file.provider.id, descriptor: { name: file.provider.name }, locations: [{ id: `${file.provider.id}-L1` }] },
          fulfillments,
          quote: q.quote,
          payment: { type: 'ON-FULFILLMENT', collected_by: 'BPP', status: 'NOT-PAID', params: { amount: q.quote.price.value, currency: 'INR' } },
        },
      });
    },
    confirm: (env) => {
      const order = env.message.order!;
      const q = quoteFor(order.items);
      if ('error' in q) return respond('confirm', env, { order }, q.error);
      if (order.quote && order.quote.price.value !== q.quote.price.value) {
        return respond('confirm', env, { order }, { code: '40003', message: 'quote changed; select again' });
      }
      for (const it of order.items) stock.set(it.id, (stock.get(it.id) ?? 0) - it.quantity.count);
      const id = `${file.order_prefix}-${++seq}`;
      const now = new Date().toISOString();
      const confirmed: Order = {
        ...order,
        id,
        state: 'Accepted',
        quote: q.quote,
        fulfillments: (order.fulfillments ?? []).map((f) => ({ ...f, state: { descriptor: { code: 'Pending' } } })),
        created_at: now,
        updated_at: now,
      };
      orders.set(id, { order: confirmed, createdAt: Date.now(), bapUri: env.context.bap_uri, transactionId: env.context.transaction_id });
      respond('confirm', env, { order: confirmed });
    },
    status: (env) => {
      const o = orders.get(env.message.order_id ?? '');
      if (!o || o.transactionId !== env.context.transaction_id) return respond('status', env, {}, { code: '40400', message: 'order not found' });
      const stage = stageOf(o);
      o.order.fulfillments = (o.order.fulfillments ?? []).map((f) => ({ ...f, state: { descriptor: { code: stage } } }));
      if (stage === 'Order-delivered') o.order.state = 'Completed';
      else if (stage !== 'Cancelled' && stage !== 'Pending') o.order.state = 'In-progress';
      o.order.updated_at = new Date().toISOString();
      respond('status', env, { order: o.order });
    },
    cancel: (env) => {
      const o = orders.get(env.message.order_id ?? '');
      if (!o || o.transactionId !== env.context.transaction_id) return respond('cancel', env, {}, { code: '40400', message: 'order not found' });
      const stage = stageOf(o);
      if (stage !== 'Pending' && stage !== 'Packed' && stage !== 'Cancelled') {
        return respond('cancel', env, { order: o.order }, { code: '50001', message: 'the order is already out for delivery and cannot be cancelled' });
      }
      if (o.order.state !== 'Cancelled') {
        for (const it of o.order.items) stock.set(it.id, (stock.get(it.id) ?? 0) + it.quantity.count);
        o.order.state = 'Cancelled';
        o.order.cancellation = { cancelled_by: env.context.bap_id, reason: { id: env.message.cancellation_reason_id ?? '001' } };
        o.order.fulfillments = (o.order.fulfillments ?? []).map((f) => ({ ...f, state: { descriptor: { code: 'Cancelled' } } }));
      }
      respond('cancel', env, { order: o.order });
    },
  };

  const r = new Router();
  // Test hook: how many orders this seller has confirmed (proves "at most once" across restarts).
  r.on('GET', '/_debug/orders', () => json(200, { confirmed: orders.size, ids: [...orders.keys()] }));
  for (const action of Object.keys(handlers) as BecknAction[]) {
    r.on('POST', `/${action}`, async (req) => {
      const v = await verifyAuthorizationHeader(req.headers.authorization, req.rawBody, registry.keyLookup());
      if (!v.ok) return json(401, nack('10001', v.reason));
      const env = req.body as BecknEnvelope;
      if (!env?.context || env.context.action !== action) return json(400, nack('10002', 'context.action does not match endpoint'));
      if (env.context.bap_id !== v.subscriberId) return json(401, nack('10001', 'signer is not context.bap_id'));
      // Only call back to the URL the registry lists for this buyer app (no open redirect of callbacks).
      const bap = (await registry.lookup({ subscriber_id: env.context.bap_id, type: 'BAP' }))[0];
      if (!bap || !env.context.bap_uri.startsWith(bap.subscriber_url)) return json(401, nack('10003', 'bap_uri is not registered for bap_id'));
      if (action !== 'search' && env.context.bpp_id !== file.subscriber_id) return json(400, nack('10002', 'wrong bpp_id'));
      handlers[action](env);
      return json(200, ACK);
    });
  }
  return r;
}

export function startSeller(opts: SellerOptions, port: number) {
  return startServer(sellerRouter(opts), port);
}
