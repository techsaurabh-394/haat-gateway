/**
 * Regression: a seller ACKs confirm but its on_confirm arrives after the gateway stopped
 * waiting. Before the fix, the gateway treated that as a failure and sent confirm again when the
 * agent retried the same approval (one approval, two orders). Now the outcome stays unknown
 * (503) until the late on_confirm settles it, even across a gateway restart.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';

const dir = mkdtempSync(join(tmpdir(), 'haat-late-'));
let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;
const delivery = { name: 'Test User', phone: '9876543210', address: { locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  net = await startNetwork({
    stageSec: 60,
    searchWindowMs: 400,
    sellerConfirmDelayMs: 2500, // on_confirm arrives 2.5 s after confirm...
    extraGatewayConfig: { dbPath: join(dir, 'haat.db'), becknTimeoutMs: 800 }, // ...but the gateway waits 0.8 s
  });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function sellerCounts(bppId: string) {
  const seller = net.sellers.find((s) => s.id === bppId)!;
  const orders = (await (await fetch(`${seller.url}/_debug/orders`)).json()) as { confirmed: number };
  const confirms = (await (await fetch(`${seller.url}/_debug/confirms`)).json()) as { received: number };
  return { orders: orders.confirmed, confirms: confirms.received };
}

test('a late on_confirm settles the operation after a restart; confirm is never re-sent', async () => {
  const sid = agent.newSession();
  const b = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent('1 kilo chini')}`)).body.suggested_basket;
  const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery };
  const op = (await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart })).body.operation;
  const approval = { operation_id: op.operation_id, revision: op.revision };

  // The seller ACKs confirm but answers after the gateway's wait: the outcome is unknown.
  const first = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(first.status, 503, JSON.stringify(first.body));

  // Retrying the same approval must NOT send confirm again.
  const retry = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(retry.status, 503);
  assert.deepEqual(await sellerCounts(b.bpp_id), { orders: 1, confirms: 1 });

  // The gateway restarts before the seller's answer arrives; the pending confirm is on disk.
  await net.restartGateway();

  // The late on_confirm reaches the restarted gateway and settles the operation.
  const deadline = Date.now() + 8000;
  while (net.gateway.commerce.pendingConfirms().length > 0 && Date.now() < deadline) await sleep(100);

  const settled = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(settled.status, 201, JSON.stringify(settled.body));
  assert.ok(settled.body.order_id);
  const again = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(again.body.order_id, settled.body.order_id);

  assert.deepEqual(await sellerCounts(b.bpp_id), { orders: 1, confirms: 1 });
  const list = await agent.call(company, sid, 'GET', '/api/v1/orders');
  assert.deepEqual(list.body.orders.map((o: any) => o.order_id), [settled.body.order_id]);
  assert.equal(net.gateway.gate.unresolved().length, 0);
  assert.equal(net.gateway.commerce.pendingConfirms().length, 0);
});
