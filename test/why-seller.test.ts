/**
 * "Why this seller?": the explanation must come from the comparison buildBasket really made,
 * and must always say what was NOT compared.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildBasket, explainWhy, NOT_COMPARED, type Offer } from '../src/commerce/basket.ts';
import type { Term } from '../src/lexicon/normalize.ts';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';

const offer = (o: Partial<Offer>): Offer => ({ bppId: 'b1', bppUri: 'x', providerId: 'p1', providerName: 'Shop 1', itemId: 'i', name: 'n', price: 10, available: 50, term: 't', ...o });
const term = (t: string): Term => ({ raw: t, term: t, matched: true });
const shop = (id: string, items: Array<[string, number]>) => items.map(([t, price]) => offer({ providerId: id, providerName: `Shop ${id}`, itemId: `${id}-${t}`, term: t, price }));

test('only one seller had anything: says so, no alternatives', () => {
  const b = buildBasket([term('rice')], shop('A', [['rice', 70]]))!;
  assert.equal(b.why!.reason, 'only_seller');
  assert.deepEqual(b.why!.alternatives, []);
  assert.equal(b.why!.sellers_compared, 1);
  assert.match(explainWhy(b), /only seller/);
});

test('covers the most items beats a cheaper seller, and the cheaper one is named honestly', () => {
  const b = buildBasket([term('rice'), term('sugar')], [...shop('A', [['rice', 50]]), ...shop('B', [['rice', 80], ['sugar', 40]])])!;
  assert.equal(b.providerId, 'B');
  assert.equal(b.why!.reason, 'covers_most');
  assert.deepEqual(b.why!.alternatives, [{ provider_name: 'Shop A', covered: 1, items_total: 50, versus: 'cheaper_but_covers_less' }]);
  const text = explainWhy(b);
  assert.match(text, /covers the most of your list \(2 of 2 items\) among 2 sellers/);
  assert.match(text, /Shop A: cheaper \(₹50\) but only 1 of 2 items/);
});

test('same coverage: cheapest total wins', () => {
  const b = buildBasket([term('rice')], [...shop('A', [['rice', 90]]), ...shop('B', [['rice', 70]]), ...shop('C', [['rice', 80]])])!;
  assert.equal(b.providerId, 'B');
  assert.equal(b.why!.reason, 'cheapest_among_equal');
  assert.deepEqual(b.why!.alternatives.map((a) => [a.provider_name, a.versus]), [['Shop C', 'costs_more'], ['Shop A', 'costs_more']]);
  assert.match(explainWhy(b), /lowest items total \(₹70\)/);
});

test('an exact tie is reported as a tie, not as a merit', () => {
  const b = buildBasket([term('rice')], [...shop('A', [['rice', 70]]), ...shop('B', [['rice', 70]])])!;
  assert.equal(b.why!.reason, 'same_total_first_answer');
  assert.equal(b.why!.alternatives[0]!.versus, 'same_total');
  assert.match(explainWhy(b), /tie/);
});

test('lists at most 3 alternatives, best first', () => {
  const b = buildBasket([term('rice')], ['A', 'B', 'C', 'D', 'E'].flatMap((id, i) => shop(id, [['rice', 70 + i * 5]])))!;
  assert.equal(b.why!.sellers_compared, 5);
  assert.equal(b.why!.alternatives.length, 3);
  assert.deepEqual(b.why!.alternatives.map((a) => a.items_total), [75, 80, 85]);
});

test('every explanation, in both languages, states what was not compared', () => {
  const b = buildBasket([term('rice')], [...shop('A', [['rice', 90]]), ...shop('B', [['rice', 70]])])!;
  assert.deepEqual(b.why!.not_compared, NOT_COMPARED);
  for (const x of NOT_COMPARED) assert.ok(explainWhy(b).includes(x), x);
  assert.match(explainWhy(b, 'hi-IN'), /डिलीवरी शुल्क, दूरी, डिलीवरी समय और विक्रेता की विश्वसनीयता नहीं देखी गई/);
  assert.match(explainWhy(b, 'hi-IN'), /सबसे कम/);
});

test('the explanation never mentions things that were not compared as reasons', () => {
  const b = buildBasket([term('rice')], [...shop('A', [['rice', 90]]), ...shop('B', [['rice', 70]])])!;
  const body = explainWhy(b).split('\nNot considered:')[0]!;
  for (const x of ['nearest', 'closest', 'fastest', 'trusted', 'reliable', 'rated']) assert.ok(!body.includes(x), x);
});

// ---- over HTTP on the mock network ----
let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;
before(async () => {
  net = await startNetwork({ stageSec: 3, searchWindowMs: 400 });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
});

test('search returns why, matching the basket that was suggested', async () => {
  const r = await agent.call(company, agent.newSession(), 'GET', `/api/v1/search?q=${encodeURIComponent('2 kilo aata aur 1 litre doodh')}`);
  assert.equal(r.status, 200);
  const b = r.body.suggested_basket;
  assert.equal(b.provider_name, 'Kashi Kirana Store');
  assert.equal(b.why.covered, b.items.length);
  assert.equal(b.why.wanted, 2);
  assert.ok(b.why.sellers_compared >= 2);
  assert.ok(b.why.text.includes('Kashi Kirana Store'));
  assert.ok(b.why.text_hi.includes('Kashi Kirana Store'));
  assert.ok(b.why.text.includes('Not considered: delivery fee'));
  // the "why" must not carry anything the offers list does not already show
  assert.doesNotMatch(JSON.stringify(b.why), /phone|address|token/i);
});

test('asking "why this seller?" in a conversation answers from the same comparison', async () => {
  const sid = agent.newSession();
  let r = await agent.say(company, sid, null, { text: '2 kilo atta aur 1 litre doodh', context: { locale: 'en-IN', user_available: true } });
  const convId = r.body.conversation_id;
  const last = (res: typeof r) => [...res.body.events].reverse().find((e: any) => e.type === 'message' && e.message.role === 'company')?.message;
  const first = last(r);
  assert.match(first.text, /Best match/);
  r = await agent.say(company, sid, convId, { text: 'why this seller?' });
  const m = last(r);
  assert.match(m.text, /covers the most of your list|only seller|lowest items total/);
  assert.ok(m.data.why.not_compared.includes('delivery fee'));
  assert.equal(m.data.why.covered, first.data.basket.lines.length);

  r = await agent.say(company, sid, convId, { text: 'yeh dukan kyun?' });
  assert.ok(last(r).data.why, 'Hinglish phrasing also works');
});

test('asking why with no search yet is treated as an ordinary message, not a crash', async () => {
  const sid = agent.newSession();
  const r = await agent.say(company, sid, null, { text: 'why this seller?', context: { locale: 'en-IN', user_available: true } });
  assert.equal(r.status, 201);
  const m = [...r.body.events].reverse().find((e: any) => e.type === 'message' && e.message.role === 'company')?.message;
  assert.ok(m, 'the company answered');
  assert.equal(m.data?.why, undefined, 'no explanation is invented when there was no search');
});
