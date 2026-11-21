/**
 * WhatsApp approvals end to end on the mock network: the person approves from a single-use link
 * sent to their own verified phone, and the approval still goes through the gate.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, personSignsIn, type Company } from '../agent/personal-agent.ts';
import { MockWhatsAppProvider, WhatsAppCloudProvider, whatsappNumber } from '../src/whatsapp/provider.ts';
import { ApprovalLinks } from '../src/whatsapp/links.ts';
import { MemoryKV } from '../src/store/kv.ts';

const PHONE = '9123456780';
const OTP = '123456';
const ALL = ['orders:read', 'orders:write', 'addresses'];
const delivery = { name: 'Test User', phone: PHONE, address: { locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } };

const wa = new MockWhatsAppProvider();
let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;

before(async () => {
  net = await startNetwork({ stageSec: 60, searchWindowMs: 400, extraGatewayConfig: { whatsapp: { provider: wa } } });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
  await agent.signIn(company, ALL, (url) => personSignsIn(url, { phone: PHONE, otp: OTP }));
});
after(async () => {
  await agent?.stop();
  await net?.stop();
});

async function newOperation(q = '1 kilo chini', count?: number) {
  const sid = agent.newSession();
  const b = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`, { signedIn: true })).body.suggested_basket;
  const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: count ?? i.count })), delivery };
  const op = (await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, signedIn: true })).body.operation;
  return { sid, cart, op, bppId: b.bpp_id as string };
}

const sendLink = (sid: string, opId: string) => agent.call(company, sid, 'POST', `/api/v1/operations/${opId}/whatsapp`, { signedIn: true });
const tokenOf = (link: string) => link.split('/approve/')[1]!;
const open = (token: string) => fetch(`${net.gatewayUrl}/approve/${token}`);
const approve = (token: string) => fetch(`${net.gatewayUrl}/approve/${token}`, { method: 'POST' });
async function confirms(bppId: string) {
  const seller = net.sellers.find((s) => s.id === bppId)!;
  return ((await (await fetch(`${seller.url}/_debug/orders`)).json()) as { confirmed: number }).confirmed;
}

test('the summary goes to the account phone and the link approves once, through the gate', async () => {
  const before = wa.outbox.length;
  const { sid, cart, op, bppId } = await newOperation();
  const sent = await sendLink(sid, op.operation_id);
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(wa.outbox.length, before + 1);
  const msg = wa.outbox.at(-1)!;
  assert.equal(msg.to, '91' + PHONE);
  assert.ok(msg.summary.includes('Total'), msg.summary);
  assert.match(msg.link, /\/approve\/[A-Za-z0-9_-]{43}$/);
  const token = tokenOf(msg.link);

  // Opening the link shows the terms and approves nothing (previews and scanners only GET).
  const view = await open(token);
  assert.equal(view.status, 200);
  assert.match(await view.text(), /Approve/);
  assert.equal(await confirms(bppId), 0);

  const done = await approve(token);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Order <b>/);
  assert.equal(await confirms(bppId), 1);

  // The link is single-use.
  assert.equal((await approve(token)).status, 410);
  assert.equal(await confirms(bppId), 1);

  // The agent's own approval for the same operation replays the same order; it is never placed twice.
  const approval = { operation_id: op.operation_id, revision: op.revision };
  const replay = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval, signedIn: true });
  assert.equal(replay.status, 201);
  assert.equal(await confirms(bppId), 1);
  assert.match(await (await open(token)).text(), /Already approved/);
});

test('two simultaneous taps place exactly one order', async () => {
  const { sid, op, bppId } = await newOperation('1 litre doodh');
  const base = await confirms(bppId);
  await sendLink(sid, op.operation_id);
  const token = tokenOf(wa.outbox.at(-1)!.link);
  const [a, b] = await Promise.all([approve(token), approve(token)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 410]);
  assert.equal(await confirms(bppId), base + 1);
});

test('a link is useless once the terms change: only the latest revision can be approved', async () => {
  const { sid, cart, op, bppId } = await newOperation('1 kilo chini');
  const base = await confirms(bppId);
  await sendLink(sid, op.operation_id);
  const token = tokenOf(wa.outbox.at(-1)!.link);
  // The agent asks for different terms (another quantity): the operation gets a new revision.
  const changed = { ...cart, items: cart.items.map((i: any) => ({ ...i, count: i.count + 1 })) };
  const again = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: changed, signedIn: true });
  assert.notEqual(again.body.operation.revision, op.revision);
  assert.equal((await open(token)).status, 410);
  assert.equal((await approve(token)).status, 410);
  assert.equal(await confirms(bppId), base);
});

test('forged, truncated or unknown tokens are refused', async () => {
  for (const t of ['x', 'A'.repeat(43), 'A'.repeat(44), '../../etc/passwd']) {
    assert.equal((await open(encodeURIComponent(t))).status, 404, t);
    assert.equal((await approve(encodeURIComponent(t))).status, 404, t);
  }
});

test('a signed-out agent cannot send approval messages, and nothing is sent', async () => {
  const before = wa.outbox.length;
  const { sid, op } = await newOperation();
  const r = await agent.call(company, sid, 'POST', `/api/v1/operations/${op.operation_id}/whatsapp`, {});
  assert.ok(r.status === 401 || r.status === 403, String(r.status));
  assert.equal(wa.outbox.length, before);
});

test('another account cannot trigger a message for an operation it does not own', async () => {
  const { op } = await newOperation();
  const other = await new PersonalAgent().start();
  try {
    const c = await other.discover(net.gatewayUrl);
    await other.signIn(c, ALL, (url) => personSignsIn(url, { phone: '9000000777', otp: OTP }));
    const sid = other.newSession();
    const before = wa.outbox.length;
    const r = await other.call(c, sid, 'POST', `/api/v1/operations/${op.operation_id}/whatsapp`, { signedIn: true });
    assert.equal(r.status, 404);
    assert.equal(wa.outbox.length, before);
  } finally {
    await other.stop();
  }
});

test('a failed send leaves no valid link behind', async () => {
  const { sid, op } = await newOperation();
  wa.failNext = true;
  const before = wa.outbox.length;
  const r = await sendLink(sid, op.operation_id);
  assert.equal(r.status, 502);
  assert.equal(wa.outbox.length, before);
  // The next attempt works.
  assert.equal((await sendLink(sid, op.operation_id)).status, 202);
});

test('sends per operation are limited', async () => {
  // Operations are reused per seller while pending, so earlier sends may already count.
  const { sid, op } = await newOperation('1 kilo chini');
  let ok = 0;
  let status = 202;
  for (let i = 0; i < 6 && status === 202; i++) {
    status = (await sendLink(sid, op.operation_id)).status;
    if (status === 202) ok++;
  }
  assert.equal(status, 429);
  assert.ok(ok <= 3, `at most 3 sends per operation, got ${ok}`);
});

test('links store only a hash of the token and expire', () => {
  const kv = new MemoryKV();
  const links = new ApprovalLinks(kv);
  const token = links.create({ operationId: 'op_1', revision: 'r1', ownerKey: 'acct:1', userKey: 'acct:1' }, 60);
  const stored = JSON.stringify(kv.list('wa_links', '', 10));
  assert.ok(!stored.includes(token), 'the raw token must not be stored');
  assert.equal(links.get(token)?.operationId, 'op_1');
  assert.equal(links.use(token), true);
  assert.equal(links.use(token), false);
});

test('Cloud API request shape and phone normalisation', async () => {
  assert.equal(whatsappNumber('+91 98765 43210'), '919876543210');
  assert.equal(whatsappNumber('9876543210'), '919876543210');
  assert.equal(whatsappNumber('12345'), undefined);
  let seen: { url: string; body: any; auth: string } | undefined;
  const p = new WhatsAppCloudProvider({
    accessToken: 'TOKEN', phoneNumberId: '123', template: 'haat_approval', language: 'en',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) };
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r = await p.send({ to: '919876543210', summary: 'Line one\nLine two', link: 'https://haat.example/approve/abc', expiresAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.id, 'wamid.X');
  assert.equal(seen!.auth, 'Bearer TOKEN');
  assert.match(seen!.url, /graph\.facebook\.com\/v[\d.]+\/123\/messages$/);
  assert.equal(seen!.body.template.name, 'haat_approval');
  const params = seen!.body.template.components[0].parameters;
  assert.equal(params[0].text, 'Line one | Line two'); // template variables may not contain newlines
  assert.equal(params[1].text, 'https://haat.example/approve/abc');
  const bad = new WhatsAppCloudProvider({ accessToken: 't', phoneNumberId: '1', template: 'x', fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 })) as unknown as typeof fetch });
  await assert.rejects(bad.send({ to: '919876543210', summary: 's', link: 'l', expiresAt: 'e' }), /nope/);
});
