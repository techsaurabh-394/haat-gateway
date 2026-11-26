/**
 * npm run loadtest                     defaults: 20 workers, 200 orders
 * npm run loadtest -- --workers 50 --orders 500 --search-window 100 --json
 *
 * Runs the whole order flow against the LOCAL mock network (one process, loopback HTTP, three
 * mock sellers, in-memory store) and prints measured latencies. It also checks the safety claim
 * under load: every retried approval must return the same order, and no order may be placed twice.
 *
 * Mock sellers have only 15-40 units per item and correctly refuse orders once an item sells out,
 * so the benchmark multiplies their stock by 1000 (otherwise it would measure inventory, not the gateway).
 *
 * What the numbers are NOT: they say nothing about real ONDC sellers, real networks or a deployed
 * server. They show the gateway's own overhead (signature checks, parsing, gate, store) with
 * instant mock sellers, plus the fixed search window you choose.
 */
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent } from '../agent/personal-agent.ts';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} needs a positive number`);
  return v;
}
const WORKERS = arg('workers', 20);
const ORDERS = arg('orders', 200);
const WINDOW = arg('search-window', 100);
// The gateway limits each client to 120 requests a minute by default. One load-test agent is one
// client, so the benchmark raises the limit (the limiter itself is tested elsewhere). Pass
// --rate-limit 120 to see the default limiter answer 429.
const RATE_LIMIT = arg('rate-limit', 1_000_000);
const AS_JSON = process.argv.includes('--json');

const delivery = {
  name: 'Load Test',
  phone: '9876543210',
  address: { building: 'B-12', locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' },
};
const QUERIES = ['2 kilo aata aur 1 litre doodh', '1 kilo chawal', '12 ande', 'do kilo atta', 'aadha kilo paneer', '1 litre doodh'];

type Series = number[];
const lat: Record<string, Series> = { search: [], approvalRequest: [], placeOrder: [], replay: [], wholeFlow: [] };

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}
const ms = (n: number) => Math.round(n * 10) / 10;
async function timed<T>(key: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await f();
  } finally {
    lat[key]!.push(performance.now() - t);
  }
}

async function main() {
  const net = await startNetwork({ stageSec: 60, stockMultiplier: 1000, searchWindowMs: WINDOW, extraGatewayConfig: { rateLimitPerMin: RATE_LIMIT } });
  const agent = await new PersonalAgent({ name: 'Load test agent' }).start();
  const failures: string[] = [];
  let placed = 0;
  let replayedSame = 0;
  const orderIds = new Set<string>();
  let next = 0;
  try {
    const company = await agent.discover(net.gatewayUrl);
    const started = performance.now();
    const worker = async () => {
      while (true) {
        const n = next++;
        if (n >= ORDERS) return;
        const t0 = performance.now();
        try {
          const sid = agent.newSession();
          const q = QUERIES[n % QUERIES.length]!;
          const s = await timed('search', () => agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`));
          if (s.status !== 200) throw new Error(`search ${s.status}`);
          const b = s.body.suggested_basket;
          if (!b?.items?.length) throw new Error('no basket');
          const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery };
          const first = await timed('approvalRequest', () => agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart }));
          if (first.status !== 403 || first.body.error !== 'approval_required') throw new Error(`expected 403 approval_required, got ${first.status}`);
          const approval = { operation_id: first.body.operation.operation_id, revision: first.body.operation.revision };
          const done = await timed('placeOrder', () => agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval }));
          if (done.status !== 201) throw new Error(`place ${done.status} ${JSON.stringify(done.body).slice(0, 120)}`);
          placed++;
          if (orderIds.has(done.body.order_id)) throw new Error(`order id ${done.body.order_id} was issued twice`);
          orderIds.add(done.body.order_id);
          const again = await timed('replay', () => agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval }));
          if (again.status === 201 && again.body.order_id === done.body.order_id) replayedSame++;
          else throw new Error(`retry of the same approval did not replay the same order (${again.status})`);
          lat.wholeFlow!.push(performance.now() - t0);
        } catch (e) {
          failures.push(`#${n}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    const seconds = (performance.now() - started) / 1000;

    let sellerCount: number | null = 0;
    for (const sl of net.sellers) {
      const r = await fetch(`${sl.url}/_debug/orders`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (typeof r?.confirmed !== 'number') sellerCount = null;
      else if (sellerCount !== null) sellerCount += r.confirmed;
    }

    const row = (k: string) => ({ n: lat[k]!.length, p50: ms(pct(lat[k]!, 50)), p95: ms(pct(lat[k]!, 95)), p99: ms(pct(lat[k]!, 99)), max: ms(Math.max(...lat[k]!)) });
    const result = {
      node: process.version,
      workers: WORKERS,
      orders_attempted: ORDERS,
      orders_placed: placed,
      unique_order_ids: orderIds.size,
      retries_replayed_same_order: replayedSame,
      seller_side_orders: sellerCount,
      failures: failures.length,
      seconds: ms(seconds),
      flows_per_second: ms(placed / seconds),
      search_window_ms: WINDOW,
      rate_limit_per_min: RATE_LIMIT,
      latency_ms: Object.fromEntries(Object.keys(lat).map((k) => [k, row(k)])),
    };
    if (AS_JSON) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`\nHaat load test (local mock network, ${process.version}, ${WORKERS} workers, search window ${WINDOW} ms, rate limit ${RATE_LIMIT}/min per client)`);
      console.log(`orders placed ${placed}/${ORDERS}, unique order ids ${orderIds.size}, retries that replayed the same order ${replayedSame}, failures ${failures.length}`);
      if (sellerCount !== null) console.log(`orders the mock sellers actually received: ${sellerCount}`);
      console.log(`${ms(seconds)} s total, ${result.flows_per_second} full flows/s\n`);
      console.log('step              n     p50     p95     p99     max   (ms)');
      for (const k of Object.keys(lat)) {
        const r = row(k);
        console.log(`${k.padEnd(16)} ${String(r.n).padStart(4)} ${String(r.p50).padStart(7)} ${String(r.p95).padStart(7)} ${String(r.p99).padStart(7)} ${String(r.max).padStart(7)}`);
      }
      for (const f of failures.slice(0, 10)) console.log(`FAIL ${f}`);
    }
    if (failures.length > 0 || orderIds.size !== placed || (sellerCount !== null && sellerCount !== placed)) process.exitCode = 1;
  } finally {
    await agent.stop();
    await net.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
