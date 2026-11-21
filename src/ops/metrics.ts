/**
 * Operator metrics, no dependencies: counters and gauges rendered in the Prometheus text format,
 * plus per-seller health (how often a seller answers, how fast). Labels are fixed small sets
 * (action, outcome, route pattern, status class), never user input, so memory stays bounded.
 */

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
};

/** What a seller did for the requests we sent it. Feeds /ops/overview. */
export class SellerStats {
  private m = new Map<string, { requests: number; answered: number; silent: number; rejected: number; ms: number; last: number }>();
  private cap: number;
  constructor(cap = 500) {
    this.cap = cap;
  }

  record(bppId: string, result: 'answered' | 'silent' | 'rejected', ms?: number): void {
    let s = this.m.get(bppId);
    if (!s) {
      if (this.m.size >= this.cap) return; // bounded: ignore new sellers past the cap
      this.m.set(bppId, (s = { requests: 0, answered: 0, silent: 0, rejected: 0, ms: 0, last: 0 }));
    }
    s.requests++;
    s[result]++;
    if (result === 'answered' && ms !== undefined) s.ms += ms;
    if (result === 'answered') s.last = Date.now();
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
    })).sort((a, b) => a.bppId.localeCompare(b.bppId));
  }
}
