/**
 * npm run demo            interactive: you approve or decline each order in the terminal
 * npm run demo -- --yes   approve automatically (used in CI)
 *
 * Starts a local network (registry, Beckn gateway, three Varanasi sellers, Haat gateway) and a
 * reference Personal Agent, then walks through the whole flow.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';
import type { Operation } from '../src/poppy/operations.ts';

const AUTO = process.argv.includes('--yes') || !stdin.isTTY;
const color = (c: number) => (s: string) => (stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = color(2);
const bold = color(1);
const green = color(32);
const yellow = color(33);
const cyan = color(36);

function step(n: number, title: string) {
  console.log(`\n${bold(cyan(`${n}. ${title}`))}`);
}

const delivery = {
  name: 'Saurabh',
  phone: '9876543210',
  address: { building: 'B-12', street: 'Durgakund Road', locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' },
  gps: '25.2783,82.9997',
};

async function ask(op: Operation, company: Company): Promise<boolean> {
  console.log(`\n   ${bold(yellow(`${company.poppy.organization.name} asks for your approval:`))}`);
  for (const line of op.summary.split('\n')) console.log(`   │ ${line}`);
  console.log(dim(`   operation ${op.operation_id}, revision ${op.revision}, expires ${op.expires_at}`));
  if (AUTO) {
    console.log(`   ${green('✔ approved')} ${dim('(--yes)')}`);
    return true;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const a = (await rl.question('   Approve? [y/N] ')).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes' || a === 'haan';
}

async function main() {
  console.log(bold('Haat gateway demo: a personal agent shops on a local ONDC-style network'));
  const net = await startNetwork({ stageSec: 4 });
  const agent = await new PersonalAgent({ name: 'Demo personal agent' }).start();
  try {
    console.log(dim(`gateway ${net.gatewayUrl} · sellers: ${net.sellers.map((s) => s.name).join(', ')}`));

    step(1, 'Discover the Company');
    const company = await agent.discover(net.gatewayUrl);
    console.log(`   ${company.poppy.organization.name} speaks Poppy ${company.poppy.protocol_version}; extensions: ${Object.keys(company.poppy.extensions ?? {}).join(', ')}`);
    const sid = agent.newSession();

    step(2, 'Search in Hinglish');
    const q = '2 kilo aata, 1 litre doodh aur 12 ande';
    console.log(`   query: "${q}"`);
    const search = await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`);
    if (search.status !== 200) throw new Error(`search failed: ${JSON.stringify(search.body)}`);
    for (const t of search.body.understood) console.log(`   ${dim('understood')} "${t.raw}" → ${t.term}${t.quantity ? ` (${t.quantity.value} ${t.quantity.unit})` : ''}`);
    const b = search.body.suggested_basket;
    console.log(`   ${search.body.offers.length} offers from the network. Best single seller: ${bold(b.provider_name)}`);
    for (const it of b.items) console.log(`   - ${it.count} × ${it.name}  ₹${it.line_total}  ${dim(`for "${it.for}", ${it.fit}`)}`);
    for (const m of b.missing) console.log(`   ${yellow('!')} ${m.raw}: ${m.reason}`);

    step(3, 'Place the order (the gateway asks the human first)');
    const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: { id: string; count: number }) => ({ id: i.id, count: i.count })), delivery };
    const placed = await agent.callWithApproval(company, sid, 'POST', '/api/v1/orders', cart, ask, { 'accept-language': 'en-IN' });
    if (placed.approved === false) {
      console.log(`   ${yellow('Declined. Nothing was ordered.')}`);
      return;
    }
    if (placed.status !== 201) throw new Error(`order failed: ${placed.status} ${JSON.stringify(placed.body)}`);
    const orderId = placed.body.order_id;
    console.log(`   ${green('✔ order placed')} ${bold(orderId)} with ${placed.body.seller.name}, total ₹${placed.body.total.amount}, payment ${placed.body.payment.type} to ${placed.body.payment.collected_by}`);

    step(4, 'Retry the same approval (network hiccup simulation)');
    const again = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: placed.operation!.operation_id, revision: placed.operation!.revision } });
    console.log(`   HTTP ${again.status}, order ${again.body.order_id} → ${again.body.order_id === orderId ? green('same order, not placed twice') : 'DIFFERENT ORDER (bug)'}`);

    step(5, 'Track it');
    for (let i = 0; i < 3; i++) {
      const st = await agent.call(company, sid, 'GET', `/api/v1/orders/${orderId}`);
      console.log(`   ${new Date().toLocaleTimeString()}  ${st.body.fulfillment_state}`);
      await new Promise((r) => setTimeout(r, 4200));
    }

    step(6, 'Same flow as a conversation with the Company Agent (Hindi)');
    let r = await agent.say(company, sid, null, { text: 'मुझे 1 किलो चावल और 2 पैकेट नमक चाहिए', context: { locale: 'hi-IN', user_available: true } });
    const convId = r.body.conversation_id;
    const lastCompany = (res: typeof r) => [...res.body.events].reverse().find((e: any) => e.type === 'message' && e.message.role === 'company')?.message;
    console.log(indent(lastCompany(r)?.text));
    r = await agent.say(company, sid, convId, { text: 'order kar do', data: { delivery } });
    const m = lastCompany(r);
    if (!m?.operation) throw new Error(`expected an operation, got: ${JSON.stringify(m)}`);
    if (await ask(m.operation, company)) {
      r = await agent.say(company, sid, convId, { approval: { operation_id: m.operation.operation_id, revision: m.operation.revision } });
      console.log(indent(lastCompany(r)?.text));
    }
    await agent.call(company, sid, 'POST', `/poppy/conversations/${convId}/close`, { body: {} });

    console.log(`\n${green(bold('Done.'))} ${dim('Everything ran locally. No real sellers or money were involved.')}`);
  } finally {
    await agent.stop();
    await net.stop();
  }
}

function indent(s: string | undefined) {
  return (s ?? '(no reply)').split('\n').map((l) => `   │ ${l}`).join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
