/**
 * End-to-end: a real Personal Agent talks Poppy over HTTP to the gateway, which talks signed
 * Beckn to a local registry, Beckn gateway and three mock sellers.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';

let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;

const delivery = {
  name: 'Test User',
  phone: '9876543210',
  address: { building: 'B-12', locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' },
};
const approveAll = async () => true;

before(async () => {
  net = await startNetwork({ stageSec: 3, searchWindowMs: 400 });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});

after(async () => {
  await agent?.stop();
  await net?.stop();
});

async function basketFor(q: string, sid: string) {
  const r = await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.suggested_basket;
}

const cartOf = (b: any) => ({ bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery });

test('discovery document follows draft 0.3', async () => {
  assert.equal(company.poppy.protocol_version, '0.3');
  assert.equal(company.poppy.extensions.operations.version, '2');
  assert.equal(company.poppy.agent.protocols[0].type, 'poppy');
  const api = await fetch(company.poppy.apis[0].url).then((r) => r.json());
  assert.equal(api.openapi, '3.1.0');
});

test('requests without a valid Session are refused', async () => {
  const r = await fetch(`${net.gatewayUrl}/api/v1/search?q=atta`);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid_session');
  const tok = await fetch(`${net.gatewayUrl}/api/v1/search?q=atta`, { headers: { authorization: 'Bearer abc' } });
  assert.equal(tok.status, 401);
});

test('Hinglish search returns a single-seller basket from the network', async () => {
  const b = await basketFor('2 kilo aata aur 1 litre doodh', agent.newSession());
  assert.equal(b.provider_name, 'Kashi Kirana Store');
  assert.deepEqual(b.items.map((i: any) => [i.id, i.count]), [['kks-atta-1kg', 2], ['kks-milk-1l', 1]]);
});

test('ordering: approval required, performed once, replayed on retry, then tracked and cancelled', async () => {
  const sid = agent.newSession();
  const cart = cartOf(await basketFor('2 kilo atta', sid));
  const first = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart });
  assert.equal(first.status, 403);
  assert.equal(first.body.error, 'approval_required');
  const op = first.body.operation;
  assert.match(op.summary, /Assi Sabzi Mandi/); // cheapest atta: 2 x 52
  assert.match(op.summary, /Total: ₹129\.00/); // 104 + 20 delivery + 5 packing
  assert.equal(op.terms.payment.type, 'ON-FULFILLMENT');

  const approval = { operation_id: op.operation_id, revision: op.revision };
  const placed = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const replay = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.order_id, placed.body.order_id);
  const list = await agent.call(company, sid, 'GET', '/api/v1/orders');
  assert.equal(list.body.orders.filter((o: any) => o.order_id === placed.body.order_id).length, 1);

  const st = await agent.call(company, sid, 'GET', `/api/v1/orders/${placed.body.order_id}`);
  assert.equal(st.status, 200);
  assert.ok(['Pending', 'Packed'].includes(st.body.fulfillment_state), st.body.fulfillment_state); // timing-tolerant

  const cancel = await agent.callWithApproval(company, sid, 'POST', `/api/v1/orders/${placed.body.order_id}/cancel`, {}, approveAll);
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal(cancel.body.state, 'Cancelled');
});

test('an approval with a changed cart performs nothing', async () => {
  const sid = agent.newSession();
  const cart = cartOf(await basketFor('1 kilo chini', sid));
  const first = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart });
  const op = first.body.operation;
  const bigger = { ...cart, items: [{ id: cart.items[0].id, count: 5 }] };
  const r = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: bigger, approval: { operation_id: op.operation_id, revision: op.revision } });
  assert.equal(r.status, 403);
  assert.equal(r.body.operation.operation_id, op.operation_id);
  assert.notEqual(r.body.operation.revision, op.revision);
  assert.match(r.body.operation.summary, /5 × Sugar 1 kg/);
});

test("another Session's approval is not accepted", async () => {
  const s1 = agent.newSession();
  const s2 = agent.newSession();
  const cart = cartOf(await basketFor('1 kilo namak', s1));
  const op = (await agent.call(company, s1, 'POST', '/api/v1/orders', { body: cart })).body.operation;
  const r = await agent.call(company, s2, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: op.operation_id, revision: op.revision } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'approval_required');
  assert.notEqual(r.body.operation.operation_id, op.operation_id);
});

test('agents that do not support Operations v2 cannot order', async () => {
  const legacy = await new PersonalAgent({ supportsOperations: false }).start();
  try {
    const c = await legacy.discover(net.gatewayUrl);
    const r = await legacy.call(c, legacy.newSession(), 'POST', '/api/v1/orders', { body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'extension_required');
    assert.equal(r.body.extension, 'operations');
  } finally {
    await legacy.stop();
  }
});

test('unknown sellers and invalid carts are rejected before reaching the network', async () => {
  const sid = agent.newSession();
  const unknown = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: { bpp_id: 'evil.example', provider_id: 'x', items: [{ id: 'a', count: 1 }], delivery } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'unknown_seller');
  const badPhone = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: { bpp_id: 'kashikirana.bpp.example', provider_id: 'x', items: [{ id: 'a', count: 1 }], delivery: { ...delivery, phone: '123' } } });
  assert.equal(badPhone.status, 400);
});

test('out-of-stock quantities surface as a seller error, not an order', async () => {
  const sid = agent.newSession();
  const r = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: { bpp_id: 'gangadairy.bpp.example', provider_id: 'P-GANGA-07', items: [{ id: 'gd-ghee-500ml', count: 99 }], delivery } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'seller_40002');
});

test("orders are private to the User who placed them", async () => {
  const sid = agent.newSession();
  const cart = cartOf(await basketFor('1 kilo aloo', sid));
  const placed = await agent.callWithApproval(company, sid, 'POST', '/api/v1/orders', cart, approveAll);
  assert.equal(placed.status, 201);
  const stranger = await new PersonalAgent().start();
  try {
    const c = await stranger.discover(net.gatewayUrl);
    const r = await stranger.call(c, stranger.newSession(), 'GET', `/api/v1/orders/${placed.body.order_id}`);
    assert.equal(r.status, 404);
  } finally {
    await stranger.stop();
  }
});

test('cancelling after pickup is refused by the seller and nothing changes', async () => {
  const sid = agent.newSession();
  const cart = cartOf(await basketFor('1 kilo pyaz', sid));
  const placed = await agent.callWithApproval(company, sid, 'POST', '/api/v1/orders', cart, approveAll);
  await new Promise((r) => setTimeout(r, 6500)); // stageSec=3: past "Packed", so pickup has happened
  const r = await agent.callWithApproval(company, sid, 'POST', `/api/v1/orders/${placed.body.order_id}/cancel`, {}, approveAll);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'seller_50001');
});

test('conversation: Hindi request, basket, delivery, operation, approval, order, status', async () => {
  const sid = agent.newSession();
  const companyMsgs = (res: any) => res.body.events.filter((e: any) => e.type === 'message' && e.message.role === 'company').map((e: any) => e.message);
  let r = await agent.say(company, sid, null, { text: 'मुझे 1 किलो चावल चाहिए', context: { locale: 'hi-IN' } });
  assert.equal(r.status, 201);
  const conv = r.body.conversation_id;
  assert.match(companyMsgs(r).at(-1).text, /Kashi Kirana Store/);
  r = await agent.say(company, sid, conv, { text: 'order kar do' });
  assert.match(companyMsgs(r).at(-1).text, /data\.delivery|Where should/);
  r = await agent.say(company, sid, conv, { text: 'order', data: { delivery } });
  const opMsg = companyMsgs(r).at(-1);
  assert.ok(opMsg.operation, JSON.stringify(opMsg));
  assert.match(opMsg.operation.summary, /कुल/);
  r = await agent.say(company, sid, conv, { approval: { operation_id: opMsg.operation.operation_id, revision: opMsg.operation.revision } });
  const done = companyMsgs(r).at(-1);
  assert.ok(done.data?.order?.order_id, JSON.stringify(done));
  r = await agent.say(company, sid, conv, { text: 'status kya hai' });
  assert.match(companyMsgs(r).at(-1).text, new RegExp(done.data.order.order_id));
  const ev = await agent.call(company, sid, 'GET', `/poppy/conversations/${conv}/events`);
  assert.ok(ev.body.events.some((e: any) => e.type === 'state'));
  assert.equal(ev.body.status, 'idle');
});

test('conversation: retrying a message ID is idempotent; reusing it with new text conflicts', async () => {
  const sid = agent.newSession();
  const message = { id: 'msg_retry_test_1', author: { type: 'agent' }, text: '1 kilo dal' };
  const a = await agent.call(company, sid, 'POST', '/poppy/conversations', { body: { message } });
  const b = await agent.call(company, sid, 'POST', '/poppy/conversations', { body: { message } });
  assert.equal(a.status, 201);
  assert.equal(b.body.conversation_id, a.body.conversation_id);
  const c = await agent.call(company, sid, 'POST', '/poppy/conversations', { body: { message: { ...message, text: '2 kilo dal' } } });
  assert.equal(c.status, 409);
  assert.equal(c.body.error, 'message_id_conflict');
});

test('conversation: handoff explains that no person is available, close is idempotent', async () => {
  const sid = agent.newSession();
  const start = await agent.say(company, sid, null, { text: 'namaste' });
  const id = start.body.conversation_id;
  const h = await agent.call(company, sid, 'POST', `/poppy/conversations/${id}/handoff`, { body: {} });
  assert.equal(h.status, 202);
  assert.equal(h.body.status, 'idle');
  const c1 = await agent.call(company, sid, 'POST', `/poppy/conversations/${id}/close`, { body: {} });
  const c2 = await agent.call(company, sid, 'POST', `/poppy/conversations/${id}/close`, { body: {} });
  assert.equal(c1.body.status, 'closed');
  assert.deepEqual(c2.body, c1.body);
  const late = await agent.say(company, sid, id, { text: 'hello?' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'conversation_closed');
});

test('forged seller callbacks are rejected', async () => {
  const r = await fetch(`${net.gatewayUrl}/beckn/on_confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { action: 'on_confirm', message_id: 'x', transaction_id: 'y' }, message: {} }),
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).message.ack.status, 'NACK');
});
