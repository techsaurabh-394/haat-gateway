/** Runs real searches against the local mock network and writes site/data/searches.json for the landing page demo. */
import { writeFileSync } from 'node:fs';
import { startNetwork } from '../../mock-network/network.ts';
import { PersonalAgent } from '../../agent/personal-agent.ts';

const queries = [
  { lang: 'Hinglish', q: '2 kilo aata, 1 litre doodh aur 12 ande' },
  { lang: 'हिन्दी', q: 'मुझे 1 किलो चावल और 2 पैकेट नमक चाहिए' },
  { lang: 'தமிழ்', q: 'இரண்டு கிலோ அரிசி மற்றும் 1 லிட்டர் பால்' },
  { lang: 'বাংলা', q: '১ কেজি চাল আর আধা কিলো পনির' },
  { lang: 'Marathi', q: 'don kilo gavhache pith ani ek litre dudh' },
];
const net = await startNetwork({ stageSec: 4 });
const agent = await new PersonalAgent({ name: 'Site data' }).start();
const out: unknown[] = [];
try {
  const company = await agent.discover(net.gatewayUrl);
  for (const { lang, q } of queries) {
    const sid = agent.newSession();
    const r = await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`);
    const b = r.body.suggested_basket;
    out.push({
      lang, q, status: r.status,
      understood: r.body.understood?.map((t: any) => ({ raw: t.raw, term: t.term, quantity: t.quantity })),
      offers: r.body.offers?.length,
      basket: b && { seller: b.provider_name, items: b.items.map((i: any) => ({ name: i.name, count: i.count, total: i.line_total })), missing: b.missing },
    });
  }
} finally { await agent.stop(); await net.stop(); }
writeFileSync(new URL('../../site/data/searches.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
