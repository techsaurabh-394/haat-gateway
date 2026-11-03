/** Restarting the gateway on the same SQLite file keeps approvals, orders and conversations. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';

const dir = mkdtempSync(join(tmpdir(), 'haat-db-'));
let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;
const delivery = { name: 'Test User', phone: '9876543210', address: { locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } };

before(async () => {
  net = await startNetwork({ stageSec: 30, searchWindowMs: 400, extraGatewayConfig: { dbPath: join(dir, 'haat.db') } });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('an approved order is not placed again after a restart; the order and Session survive', async () => {
  const sid = agent.newSession();
  const b = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent('1 kilo chini')}`)).body.suggested_basket;
  const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery };
  const op = (await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart })).body.operation;
  const approval = { operation_id: op.operation_id, revision: op.revision };
  const placed = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(placed.status, 201);

  await net.restartGateway();

  const again = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(again.status, 201);
  assert.equal(again.body.order_id, placed.body.order_id);
  const seller = net.sellers.find((s) => s.id === b.bpp_id)!;
  const debug = await (await fetch(`${seller.url}/_debug/orders`)).json();
  assert.equal(debug.ids.filter((id: string) => id === placed.body.order_id).length, 1);
  assert.equal(debug.confirmed, 1);
  const list = await agent.call(company, sid, 'GET', '/api/v1/orders');
  assert.equal(list.body.orders.length, 1);
});

test('a conversation can be read and continued after a restart', async () => {
  const sid = agent.newSession();
  const r = await agent.say(company, sid, null, { text: '1 kilo chawal' });
  const id = r.body.conversation_id;
  await net.restartGateway();
  const ev = await agent.call(company, sid, 'GET', `/poppy/conversations/${id}/events`);
  assert.equal(ev.status, 200);
  assert.ok(ev.body.events.length >= 2);
  const more = await agent.say(company, sid, id, { text: 'namaste' });
  assert.equal(more.status, 202);
});
