/**
 * Operator metrics, no dependencies: counters and gauges rendered in the Prometheus text format,
 * plus per-seller health (how often a seller answers, how fast). Labels are fixed small sets
 * (action, outcome, route pattern, status class), never user input, so memory stays bounded.
 */
import type { KV } from '../store/kv.ts';
import type { Reliability } from '../commerce/basket.ts';

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

type Labels = Record<string, string>;
const key = (l: Labels) => Object.keys(l).sort().map((k) => `${k}="${esc(l[k]!)}"`).join(',');

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();
  private gauges: Array<{ name: string; help: string; read: () => number }> = [];
  private histograms = new Map<string, { help: string; buckets: number[]; values: Map<string, { counts: number[]; sum: number; n: number }> }>();

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = { help, values: new Map() }));
    const k = key(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }

  gauge(name: string, help: string, read: () => number): void {
    this.gauges.push({ name, help, read });
  }

  observe(name: string, help: string, seconds: number, labels: Labels = {}, buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]): void {
    let h = this.histograms.get(name);
    if (!h) this.histograms.set(name, (h = { help, buckets, values: new Map() }));
    const k = key(labels);
    let v = h.values.get(k);
    if (!v) h.values.set(k, (v = { counts: h.buckets.map(() => 0), sum: 0, n: 0 }));
    h.buckets.forEach((b, i) => {
      if (seconds <= b) v!.counts[i]!++;
    });
    v.sum += seconds;
    v.n++;
  }

  /** Current value of one counter series (for tests and the ops CLI). */
  value(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.values.get(key(labels)) ?? 0;
  }

  render(): string {
    const out: string[] = [];
    const line = (name: string, k: string, v: number) => out.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    for (const [name, c] of [...this.counters].sort()) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.values) line(name, k, v);
    }
    for (const g of this.gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      let v: number;
      try {
        v = g.read();
      } catch {
        v = Number.NaN;
      }
      line(g.name, '', v);
    }
    for (const [name, h] of [...this.histograms].sort()) {
      out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
      for (const [k, v] of h.values) {
        h.buckets.forEach((b, i) => line(`${name}_bucket`, [k, `le="${b}"`].filter(Boolean).join(','), v.counts[i]!));
        line(`${name}_bucket`, [k, 'le="+Inf"'].filter(Boolean).join(','), v.n);
        line(`${name}_sum`, k, v.sum);
        line(`${name}_count`, k, v.n);
      }
    }
    return out.join('\n') + '\n';
  }
}

export type SellerHealth = {
  bppId: string;
  requests: number;
  answered: number;
  silent: number;
  rejected: number;
  /** answered / requests, 0..1 (null before any request). */
  answerRate: number | null;
  avgMs: number | null;
  lastSeen: string | null;
  /** Answers that came after we had stopped waiting (counted inside `silent`). */
  late: number;
  reliability: Reliability;
};

/** Calls kept per seller for the reliability label. Old behaviour ages out. */
export const RELIABILITY_WINDOW = 50;
/** Fewer recent calls than this and no label is given. */
export const RELIABILITY_MIN_CALLS = 10;
export const SLOW_MS = 3000;

type Row = { requests: number; answered: number; silent: number; rejected: number; ms: number; last: number; late: number; recent: Array<[0 | 1, number]> };

/**
 * What a seller did for the requests we sent it. Feeds /ops/overview and the reliability label.
 * Persisted in the store (when given one) so a restart does not wipe the history.
 */
export class SellerStats {
  private m = new Map<string, Row>();
  private cap: number;
  private kv: KV | undefined;
  constructor(cap = 500, kv?: KV) {
    this.cap = cap;
    this.kv = kv;
    if (kv) for (const { key, value } of kv.list<Row>(NS, '', cap)) this.m.set(key, { ...value, late: value.late ?? 0, recent: value.recent ?? [] });
  }

  private row(bppId: string): Row | undefined {
    let s = this.m.get(bppId);
    if (!s) {
      if (this.m.size >= this.cap) return undefined; // bounded: ignore new sellers past the cap
      this.m.set(bppId, (s = { requests: 0, answered: 0, silent: 0, rejected: 0, ms: 0, last: 0, late: 0, recent: [] }));
    }
    return s;
  }
  private save(bppId: string, s: Row): void {
    try {
      this.kv?.set(NS, bppId, s);
    } catch {
      /* a full or failing store must never break an order */
    }
  }

  record(bppId: string, result: 'answered' | 'silent' | 'rejected', ms?: number): void {
    const s = this.row(bppId);
    if (!s) return;
    s.requests++;
    s[result]++;
    if (result === 'answered' && ms !== undefined) s.ms += ms;
    if (result === 'answered') s.last = Date.now();
    // A refusal can be our fault (a bad request), so it is left out of the reliability window.
    if (result !== 'rejected') {
      s.recent.push([result === 'answered' ? 1 : 0, result === 'answered' ? Math.round(ms ?? 0) : 0]);
      if (s.recent.length > RELIABILITY_WINDOW) s.recent.shift();
    }
    this.save(bppId, s);
  }

  /** A seller's answer arrived after we had stopped waiting for it. */
  recordLate(bppId: string): void {
    const s = this.row(bppId);
    if (!s) return;
    s.late++;
    this.save(bppId, s);
  }

  reliability(bppId: string): Reliability {
    return reliabilityOf(this.m.get(bppId));
  }

  snapshot(): SellerHealth[] {
    return [...this.m].map(([bppId, s]) => ({
      bppId,
      requests: s.requests,
      answered: s.answered,
      silent: s.silent,
      rejected: s.rejected,
      answerRate: s.requests ? Number((s.answered / s.requests).toFixed(3)) : null,
      avgMs: s.answered ? Math.round(s.ms / s.answered) : null,
      lastSeen: s.last ? new Date(s.last).toISOString() : null,
      late: s.late,
      reliability: reliabilityOf(s),
    })).sort((a, b) => a.bppId.localeCompare(b.bppId));
  }
}

const NS = 'seller_stats';

/**
 * A label, not a score. It says how often the seller answered Haat's own calls over its last
 * RELIABILITY_WINDOW calls. It cannot see cancellations by the seller, quality, or delivery.
 */
function reliabilityOf(s: Row | undefined): Reliability {
  const recent = s?.recent ?? [];
  const calls = recent.length;
  if (calls < RELIABILITY_MIN_CALLS) return { label: 'not_enough_data', calls, answer_rate: null, avg_ms: null, slow: false };
  const answered = recent.filter((r) => r[0] === 1);
  const rate = Number((answered.length / calls).toFixed(3));
  const avg = answered.length ? Math.round(answered.reduce((t, r) => t + r[1], 0) / answered.length) : null;
  const label = rate >= 0.95 ? 'reliable' : rate >= 0.8 ? 'mixed' : 'unreliable';
  return { label, calls, answer_rate: rate, avg_ms: avg, slow: avg !== null && avg > SLOW_MS };
}
