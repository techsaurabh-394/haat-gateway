/**
 * Operator endpoints: /healthz, /readyz, /metrics, /ops/overview. A silent seller creates a
 * real stuck order, and the overview must show it without leaking user data.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';
import { Metrics, SellerStats } from '../src/ops/metrics.ts';
import { tokenOk } from '../src/ops/routes.ts';

const TOKEN = 'ops-test-token-0123456789';
const delivery = { name: 'Test User', phone: '9876543210', address: { locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } };
let net: Awaited<ReturnType<typeof startNetwork>>;
let off: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;
const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  net = await startNetwork({ stageSec: 60, searchWindowMs: 400, sellerChaos: { seed: 3, silentRate: 1 }, extraGatewayConfig: { becknTimeoutMs: 500, opsToken: TOKEN } });
  off = await startNetwork({ stageSec: 60, searchWindowMs: 400 }); // no operator token configured
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
  await off?.stop();
});

test('healthz and readyz are open and reveal nothing', async () => {
  const h = await fetch(`${net.gatewayUrl}/healthz`);
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(await h.json()).sort(), ['ok', 'uptime_s']);
  const r = await fetch(`${net.gatewayUrl}/readyz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ready: true });
});

test('metrics and overview: 401 without or with a wrong token, 404 when the feature is off', async () => {
  for (const path of ['/metrics', '/ops/overview']) {
    assert.equal((await fetch(`${net.gatewayUrl}${path}`)).status, 401, path);
    assert.equal((await fetch(`${net.gatewayUrl}${path}`, { headers: { authorization: 'Bearer wrong' } })).status, 401, path);
    assert.equal((await fetch(`${net.gatewayUrl}${path}`, { headers: { authorization: TOKEN } })).status, 401, `${path} needs the Bearer scheme`);
    assert.equal((await fetch(`${off.gatewayUrl}${path}`, { headers: auth })).status, 404, `${path} must be off without a token`);
  }
  const bad = await fetch(`${net.gatewayUrl}/metrics`);
  assert.match(bad.headers.get('www-authenticate') ?? '', /Bearer/);
});

test('tokenOk compares in constant shape and rejects odd headers', () => {
  assert.equal(tokenOk('abc', 'Bearer abc'), true);
  for (const h of [undefined, '', 'Bearer', 'Bearer ', 'bearer abc', 'Bearer abcd', 'Bearer ab', 'Basic abc']) assert.equal(tokenOk('abc', h), false, String(h));
});

test('a stuck order shows up in the overview and in the metrics, with no user data', async () => {
  const sid = agent.newSession();
  const b = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent('1 kilo chini')}`)).body.suggested_basket;
  const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery };
  const op = (await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart })).body.operation;
  const stuck = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: op.operation_id, revision: op.revision } });
  assert.equal(stuck.status, 503);

  const ov = await (await fetch(`${net.gatewayUrl}/ops/overview`, { headers: auth })).json();
  assert.equal(ov.unresolved_operations.length, 1);
  assert.equal(ov.unresolved_operations[0].operation_id, op.operation_id);
  assert.ok(ov.unresolved_operations[0].unknown_since);
  assert.equal(ov.pending_confirms.length, 1);
  assert.equal(ov.pending_confirms[0].operation_id, op.operation_id);
  assert.equal(ov.pending_confirms[0].seller, b.bpp_id);
  const seller = ov.sellers.find((s: any) => s.bppId === b.bpp_id);
  assert.ok(seller && seller.silent >= 1, JSON.stringify(ov.sellers));

  const text = JSON.stringify(ov);
  for (const secret of ['9876543210', 'Test User', 'Lanka', 'owner', 'userKey', TOKEN]) assert.ok(!text.includes(secret), `overview leaked ${secret}`);

  const m = await (await fetch(`${net.gatewayUrl}/metrics`, { headers: auth })).text();
  assert.match(m, /^haat_operations_unresolved 1$/m);
  assert.match(m, /^haat_confirms_pending 1$/m);
  assert.match(m, /haat_seller_calls_total\{action="confirm",result="silent"\} 1/);
  assert.match(m, /haat_http_requests_total\{route="\/api\/v1\/orders",status="5xx"\} /);
  assert.match(m, /haat_http_request_seconds_bucket\{route="\/api\/v1\/orders",le="\+Inf"\}/);
  assert.ok(!m.includes(TOKEN) && !m.includes('9876543210'));
});

test('metrics use route patterns, not raw URLs, so ids cannot blow up the label set', async () => {
  for (let i = 0; i < 5; i++) await fetch(`${net.gatewayUrl}/api/v1/orders/does-not-exist-${i}`);
  await fetch(`${net.gatewayUrl}/no/such/path/${Date.now()}`);
  const m = await (await fetch(`${net.gatewayUrl}/metrics`, { headers: auth })).text();
  assert.ok(!m.includes('does-not-exist'));
  assert.ok(!m.includes('/no/such/path'));
  assert.match(m, /route="unmatched"/);
});

test('Metrics renders valid Prometheus text and escapes label values', () => {
  const x = new Metrics();
  x.inc('t_total', 'a "counter"', { v: 'a"b\\c\nd' });
  x.inc('t_total', 'a "counter"', { v: 'a"b\\c\nd' }, 2);
  x.gauge('t_gauge', 'g', () => 7);
  x.gauge('t_broken', 'g', () => {
    throw new Error('boom');
  });
  x.observe('t_seconds', 'h', 0.2, { r: 'x' });
  const out = x.render();
  assert.match(out, /t_total\{v="a\\"b\\\\c\\nd"\} 3/);
  assert.match(out, /^t_gauge 7$/m);
  assert.match(out, /^t_broken NaN$/m);
  assert.match(out, /t_seconds_bucket\{r="x",le="0.25"\} 1/);
  assert.match(out, /t_seconds_bucket\{r="x",le="0.1"\} 0/);
  assert.match(out, /t_seconds_count\{r="x"\} 1/);
});

test('SellerStats is bounded and computes answer rate', () => {
  const s = new SellerStats(2);
  s.record('a', 'answered', 100);
  s.record('a', 'silent');
  s.record('b', 'answered', 300);
  s.record('c', 'answered', 1); // over the cap: ignored
  const snap = s.snapshot();
  assert.equal(snap.length, 2);
  assert.deepEqual(snap[0], { ...snap[0]!, bppId: 'a', requests: 2, answered: 1, silent: 1, answerRate: 0.5, avgMs: 100 });
});
