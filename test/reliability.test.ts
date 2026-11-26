/**
 * Seller reliability: a label from how often a seller answered Haat's own calls. It is shown openly
 * and may break an EXACT tie, nothing more: it must never beat a seller that covers more of the
 * list or costs less.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildBasket, explainWhy, type Offer, type Reliability } from '../src/commerce/basket.ts';
import { SellerStats, RELIABILITY_MIN_CALLS, RELIABILITY_WINDOW, SLOW_MS } from '../src/ops/metrics.ts';
import { MemoryKV } from '../src/store/kv.ts';
import type { Term } from '../src/lexicon/normalize.ts';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';

const offer = (o: Partial<Offer>): Offer => ({ bppId: 'b1', bppUri: 'x', providerId: 'p1', providerName: 'Shop 1', itemId: 'i', name: 'n', price: 10, available: 50, term: 't', ...o });
const term = (t: string): Term => ({ raw: t, term: t, matched: true });
const shop = (id: string, items: Array<[string, number]>) => items.map(([t, price]) => offer({ bppId: `bpp-${id}`, providerId: id, providerName: `Shop ${id}`, itemId: `${id}-${t}`, term: t, price }));
const rel = (label: Reliability['label'], rate = 0.9): Reliability => ({ label, calls: 30, answer_rate: rate, avg_ms: 120, slow: false });
const lookup = (m: Record<string, Reliability['label']>) => (id: string): Reliability => rel(m[id] ?? 'not_enough_data');

function feed(s: SellerStats, id: string, answered: number, silent: number, ms = 100) {
  for (let i = 0; i < answered; i++) s.record(id, 'answered', ms);
  for (let i = 0; i < silent; i++) s.record(id, 'silent');
}

// ---------- the label ----------
test('no label until there are enough recent calls', () => {
  const s = new SellerStats();
  feed(s, 'a', RELIABILITY_MIN_CALLS - 1, 0);
  assert.equal(s.reliability('a').label, 'not_enough_data');
  assert.equal(s.reliability('a').answer_rate, null);
  assert.equal(s.reliability('never-seen').label, 'not_enough_data');
  feed(s, 'a', 1, 0);
  assert.equal(s.reliability('a').label, 'reliable');
});

test('thresholds: 95% reliable, 80% mixed, below that unreliable', () => {
  const s = new SellerStats();
  feed(s, 'good', 19, 1); // 95%
  feed(s, 'mid', 16, 4); // 80%
  feed(s, 'bad', 15, 5); // 75%
  assert.equal(s.reliability('good').label, 'reliable');
  assert.equal(s.reliability('mid').label, 'mixed');
  assert.equal(s.reliability('bad').label, 'unreliable');
  assert.equal(s.reliability('bad').answer_rate, 0.75);
});

test('only the last RELIABILITY_WINDOW calls count: an old bad patch is forgiven, a new one is not', () => {
  const s = new SellerStats();
  feed(s, 'a', 0, 20);
  assert.equal(s.reliability('a').label, 'unreliable');
  feed(s, 'a', RELIABILITY_WINDOW, 0);
  assert.equal(s.reliability('a').label, 'reliable');
  assert.equal(s.reliability('a').calls, RELIABILITY_WINDOW);
  feed(s, 'a', 0, 20);
  assert.equal(s.reliability('a').label, 'unreliable');
});

test('a refusal (4xx/NACK) is not held against the seller: it may be our own bad request', () => {
  const s = new SellerStats();
  feed(s, 'a', 12, 0);
  for (let i = 0; i < 30; i++) s.record('a', 'rejected');
  assert.equal(s.reliability('a').label, 'reliable');
  assert.equal(s.snapshot()[0]!.rejected, 30, 'still visible to operators');
});

test('slow is flagged only when answers average over the limit', () => {
  const s = new SellerStats();
  feed(s, 'fast', 12, 0, 100);
  feed(s, 'slow', 12, 0, SLOW_MS + 500);
  assert.equal(s.reliability('fast').slow, false);
  assert.equal(s.reliability('slow').slow, true);
});

test('late answers are counted and shown, and do not erase the silence that came first', () => {
  const s = new SellerStats();
  feed(s, 'a', 10, 2);
  s.recordLate('a');
  const row = s.snapshot()[0]!;
  assert.equal(row.late, 1);
  assert.equal(row.silent, 2);
});

test('history survives a restart when given a store', () => {
  const kv = new MemoryKV();
  const a = new SellerStats(500, kv);
  feed(a, 'x', 14, 6);
  a.recordLate('x');
  const b = new SellerStats(500, kv); // "restart"
  assert.deepEqual(b.reliability('x'), a.reliability('x'));
  assert.equal(b.reliability('x').label, 'unreliable');
  assert.equal(b.snapshot()[0]!.late, 1);
});

test('a failing store never breaks recording', () => {
  const kv = new MemoryKV();
  kv.set = () => {
    throw new Error('disk full');
  };
  const s = new SellerStats(500, kv);
  assert.doesNotThrow(() => feed(s, 'a', 3, 1));
  assert.equal(s.snapshot()[0]!.requests, 4);
});

test('still bounded to the cap', () => {
  const s = new SellerStats(2);
  feed(s, 'a', 1, 0);
  feed(s, 'b', 1, 0);
  feed(s, 'c', 1, 0);
  assert.equal(s.snapshot().length, 2);
});

// ---------- how it is used in choosing ----------
test('it breaks an exact tie, openly', () => {
  const offers = [...shop('A', [['rice', 70]]), ...shop('B', [['rice', 70]])];
  const flaky = lookup({ 'bpp-A': 'unreliable', 'bpp-B': 'reliable' });
  const b = buildBasket([term('rice')], offers, flaky)!;
  assert.equal(b.providerId, 'B');
  assert.equal(b.why!.reason, 'same_total_more_reliable');
  assert.match(explainWhy(b), /answered Haat's requests more reliably/);
  // and with no data at all the old rule (first answer) still applies
  assert.equal(buildBasket([term('rice')], offers)!.providerId, 'A');
  assert.equal(buildBasket([term('rice')], offers, lookup({}))!.why!.reason, 'same_total_first_answer');
});

test('an unreliable seller still WINS when it covers more of the list', () => {
  const offers = [...shop('A', [['rice', 50]]), ...shop('B', [['rice', 80], ['sugar', 40]])];
  const b = buildBasket([term('rice'), term('sugar')], offers, lookup({ 'bpp-A': 'reliable', 'bpp-B': 'unreliable' }))!;
  assert.equal(b.providerId, 'B');
  assert.equal(b.why!.reason, 'covers_most');
});

test('an unreliable seller still WINS when it is cheaper with the same coverage', () => {
  const offers = [...shop('A', [['rice', 90]]), ...shop('B', [['rice', 70]])];
  const b = buildBasket([term('rice')], offers, lookup({ 'bpp-A': 'reliable', 'bpp-B': 'unreliable' }))!;
  assert.equal(b.providerId, 'B');
  assert.equal(b.why!.reason, 'cheapest_among_equal');
});

test('"not enough data" ranks with "mixed", so a new seller is neither rewarded nor punished against it', () => {
  const offers = [...shop('A', [['rice', 70]]), ...shop('B', [['rice', 70]])];
  assert.equal(buildBasket([term('rice')], offers, lookup({ 'bpp-A': 'mixed', 'bpp-B': 'not_enough_data' }))!.providerId, 'A', 'first answer stays');
  assert.equal(buildBasket([term('rice')], offers, lookup({ 'bpp-A': 'not_enough_data', 'bpp-B': 'mixed' }))!.providerId, 'A');
});

test('the chosen seller\'s label is shown even when it decided nothing, with an honest limit on what it means', () => {
  const offers = [...shop('A', [['rice', 90]]), ...shop('B', [['rice', 70]])];
  const b = buildBasket([term('rice')], offers, lookup({ 'bpp-B': 'reliable' }))!;
  assert.equal(b.why!.reliability!.label, 'reliable');
  assert.equal(b.why!.alternatives[0]!.reliability, 'not_enough_data');
  assert.match(explainWhy(b), /answered 90% of Haat's last 30 requests/);
  assert.match(explainWhy(b), /not anything about delivery or quality/);
  assert.doesNotMatch(explainWhy(b).split('\nNot considered:')[1]!, /reliab/, 'reliability is no longer listed as not considered');
  assert.match(explainWhy(b, 'hi-IN'), /डिलीवरी या गुणवत्ता नहीं/);
});

test('no label line when there is not enough data', () => {
  const b = buildBasket([term('rice')], shop('A', [['rice', 70]]), lookup({}))!;
  assert.doesNotMatch(explainWhy(b), /answered \d+%/);
});

// ---------- end to end on the mock network ----------
let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;
before(async () => {
  net = await startNetwork({ stageSec: 3, searchWindowMs: 400, extraGatewayConfig: { opsToken: 'ops-secret', rateLimitPerMin: 100000 } });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
});

const delivery = {
  name: 'Test User',
  phone: '9876543210',
  address: { building: 'B-12', locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' },
};

test('real quotes (select + init) build a label for the seller, visible to operators and in "why"; searches alone do not', async () => {
  const search = async () => (await agent.call(company, agent.newSession(), 'GET', `/api/v1/search?q=${encodeURIComponent('2 kilo aata aur 1 litre doodh')}`)).body.suggested_basket;
  // searches are fanned out through the Beckn gateway: nobody can say who stayed silent, so no history
  let b = await search();
  for (let i = 0; i < 4; i++) b = await search();
  assert.equal(b.why.reliability.label, 'not_enough_data');
  assert.doesNotMatch(b.why.text, /answered \d+%/);
  // each approval request makes the gateway call the seller directly (select, then init)
  for (let i = 0; i < 6; i++) {
    const sid = agent.newSession();
    const x = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent('2 kilo aata aur 1 litre doodh')}`)).body.suggested_basket;
    const cart = { bpp_id: x.bpp_id, provider_id: x.provider_id, items: x.items.map((it: any) => ({ id: it.id, count: it.count })), delivery };
    const r = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  }
  b = await search();
  assert.equal(b.why.reliability.label, 'reliable', JSON.stringify(b.why.reliability));
  assert.ok(b.why.reliability.calls >= RELIABILITY_MIN_CALLS);
  assert.match(b.why.text, /answered 100% of Haat's last \d+ requests/);
  const ov = await fetch(`${net.gatewayUrl}/ops/overview`, { headers: { authorization: 'Bearer ops-secret' } }).then((r) => r.json());
  assert.ok(ov.sellers.every((s: any) => 'reliability' in s && 'late' in s));
  const mine = ov.sellers.find((s: any) => s.bppId === b.bpp_id);
  assert.equal(mine.reliability.label, 'reliable');
  assert.doesNotMatch(JSON.stringify(ov.sellers), /phone|address/i);
});
