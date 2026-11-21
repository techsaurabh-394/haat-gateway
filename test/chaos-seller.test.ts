/**
 * Chaos seller: the mock sellers answer slowly, answer twice, send a forged (wrongly signed)
 * answer, or never answer. Whatever they do, one approval must place at most one order and the
 * gateway must never send confirm twice. Runs are seeded, so a failure can be replayed.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';
import type { ChaosOptions } from '../mock-network/seller.ts';

const delivery = { name: 'Test User', phone: '9876543210', address: { locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Net = Awaited<ReturnType<typeof startNetwork>>;
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(chaos: ChaosOptions, becknTimeoutMs = 800) {
  const dir = mkdtempSync(join(tmpdir(), 'haat-chaos-'));
  const net: Net = await startNetwork({ stageSec: 60, searchWindowMs: 400, sellerChaos: chaos, extraGatewayConfig: { dbPath: join(dir, 'haat.db'), becknTimeoutMs } });
  const agent = await new PersonalAgent().start();
  const company: Company = await agent.discover(net.gatewayUrl);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => net.stop(), () => agent.stop());
  return { net, agent, company };
}

async function counts(net: Net) {
  let confirms = 0;
  let orders = 0;
  for (const s of net.sellers) {
    confirms += ((await (await fetch(`${s.url}/_debug/confirms`)).json()) as { received: number }).received;
    orders += ((await (await fetch(`${s.url}/_debug/orders`)).json()) as { confirmed: number }).confirmed;
  }
  return { confirms, orders };
}

/** One person approving one order; retries the same approval like a real agent would. */
async function placeOrder(agent: PersonalAgent, company: Company, query: string, waitMs: number) {
  const sid = agent.newSession();
  const b = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent(query)}`)).body.suggested_basket;
  const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery };
  const op = (await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart })).body.operation;
  const approval = { operation_id: op.operation_id, revision: op.revision };
  const statuses: number[] = [];
  const deadline = Date.now() + waitMs;
  let orderId: string | undefined;
  do {
    const r = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
    statuses.push(r.status);
    if (r.status === 201) {
      orderId = r.body.order_id;
      break;
    }
    await sleep(250);
  } while (Date.now() < deadline);
  return { sid, orderId, statuses };
}

test('duplicate and forged callbacks still give exactly one order per approval', async () => {
  const { net, agent, company } = await setup({ seed: 7, duplicateRate: 1, badSignatureRate: 1, slowRate: 0.5, slowMs: 600 }, 3000);
  const queries = ['1 kilo chini', '1 litre doodh', '1 kilo aloo'];
  const placed = [];
  for (const q of queries) placed.push(await placeOrder(agent, company, q, 8000));

  for (const p of placed) {
    assert.ok(p.orderId, `no order for a session, statuses ${p.statuses.join(',')}`);
    assert.ok(p.statuses.every((s) => s === 201 || s === 503), `unexpected statuses ${p.statuses.join(',')}`);
  }
  assert.equal(new Set(placed.map((p) => p.orderId)).size, placed.length);
  const c = await counts(net);
  assert.equal(c.confirms, placed.length, 'confirm must be sent once per approval');
  assert.equal(c.orders, placed.length);
  assert.equal(net.gateway.gate.unresolved().length, 0);
  assert.equal(net.gateway.commerce.pendingConfirms().length, 0);
});

test('a seller that never answers leaves the outcome unknown; retries never re-send confirm', async () => {
  const { net, agent, company } = await setup({ seed: 1, silentRate: 1 });
  const p = await placeOrder(agent, company, '1 kilo chini', 3000);
  assert.equal(p.orderId, undefined);
  assert.ok(p.statuses.length >= 4, `expected several retries, got ${p.statuses.length}`);
  assert.ok(p.statuses.every((s) => s === 503), `every retry must be 503 (unknown), got ${p.statuses.join(',')}`);
  const c = await counts(net);
  assert.equal(c.confirms, 1, 'confirm must be sent exactly once');
  assert.equal(net.gateway.gate.unresolved().length, 1, 'the approval stays unresolved, not freed');
});

test('seeded mixed chaos: never more confirms than approvals, never an unexpected status', async () => {
  for (const seed of [11, 42, 2026]) {
    const { net, agent, company } = await setup({ seed, silentRate: 0.25, slowRate: 0.4, slowMs: 1200, duplicateRate: 0.4, badSignatureRate: 0.3 });
    const approvals = 6;
    const results = [];
    for (let i = 0; i < approvals; i++) results.push(await placeOrder(agent, company, ['1 kilo chini', '1 litre doodh', '1 kilo aloo'][i % 3]!, 2500));

    for (const r of results) assert.ok(r.statuses.every((s) => s === 201 || s === 503), `seed ${seed}: statuses ${r.statuses.join(',')}`);
    const ids = results.map((r) => r.orderId).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}: two approvals got the same order`);
    const c = await counts(net);
    assert.ok(c.confirms <= approvals, `seed ${seed}: ${c.confirms} confirms for ${approvals} approvals`);
    assert.ok(c.orders <= approvals, `seed ${seed}: ${c.orders} orders for ${approvals} approvals`);
    let injected = 0;
    for (const s of net.sellers) injected += Object.values((await (await fetch(`${s.url}/_debug/chaos`)).json()) as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.ok(injected > 0, `seed ${seed}: no chaos was injected, the test proved nothing`);
    await cleanupNow();
  }
});

async function cleanupNow() {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
}
