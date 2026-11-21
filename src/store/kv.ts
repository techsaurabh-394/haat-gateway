/**
 * Storage for everything the gateway must remember: Sessions, operations (at-most-once depends on
 * them), orders, conversations, OAuth codes and tokens.
 *
 * Two implementations behind one small synchronous interface:
 *   - MemoryKV: bounded, for tests and local development.
 *   - SqliteKV: a single file via node:sqlite (built into Node 22; marked experimental by Node),
 *     so state survives restarts. Set HAAT_DB=/path/haat.db.
 *
 * Every namespace has a row cap. Namespaces listed in `noEvict` (operations) refuse new entries when
 * full instead of evicting, because forgetting an operation could let it run twice.
 */
import { DatabaseSync } from 'node:sqlite';

export interface KV {
  get<T>(ns: string, key: string): T | undefined;
  set(ns: string, key: string, value: unknown, ttlSec?: number): void;
  delete(ns: string, key: string): void;
  /** Entries whose key starts with `prefix`, oldest first. */
  list<T>(ns: string, prefix?: string, limit?: number): Array<{ key: string; value: T }>;
  count(ns: string): number;
  purgeExpired(): number;
  close(): void;
}

export class StoreFullError extends Error {
  ns: string;
  constructor(ns: string) {
    super(`storage namespace "${ns}" is full`);
    this.ns = ns;
  }
}

export type KVLimits = { defaultMax: number; perNamespace?: Record<string, number>; noEvict?: string[] };

export const DEFAULT_LIMITS: KVLimits = {
  defaultMax: 50_000,
  perNamespace: { jti: 200_000, conv: 20_000, msgseen: 200_000, ratelimit: 20_000 },
  noEvict: ['ops', 'op_action', 'confirm_pending'],
};

type Entry = { v: string; exp: number; updated: number };

export class MemoryKV implements KV {
  data = new Map<string, Map<string, Entry>>();
  limits: KVLimits;
  now: () => number;

  constructor(limits: KVLimits = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  private ns(ns: string): Map<string, Entry> {
    let m = this.data.get(ns);
    if (!m) {
      m = new Map();
      this.data.set(ns, m);
    }
    return m;
  }

  private max(ns: string): number {
    return this.limits.perNamespace?.[ns] ?? this.limits.defaultMax;
  }

  get<T>(ns: string, key: string): T | undefined {
    const m = this.data.get(ns);
    const e = m?.get(key);
    if (!e) return undefined;
    if (e.exp && e.exp <= this.now()) {
      m!.delete(key);
      return undefined;
    }
    return JSON.parse(e.v) as T;
  }

  set(ns: string, key: string, value: unknown, ttlSec?: number): void {
    const m = this.ns(ns);
    if (!m.has(key) && m.size >= this.max(ns)) {
      this.purgeNs(ns);
      if (m.size >= this.max(ns)) {
        if (this.limits.noEvict?.includes(ns)) throw new StoreFullError(ns);
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
    }
    m.delete(key); // re-insert so iteration order is least recently written first
    m.set(key, { v: JSON.stringify(value), exp: ttlSec ? this.now() + ttlSec * 1000 : 0, updated: this.now() });
  }

  delete(ns: string, key: string): void {
    this.data.get(ns)?.delete(key);
  }

  list<T>(ns: string, prefix = '', limit = 1000): Array<{ key: string; value: T }> {
    const out: Array<{ key: string; value: T }> = [];
    const now = this.now();
    for (const [key, e] of this.data.get(ns) ?? []) {
      if (!key.startsWith(prefix) || (e.exp && e.exp <= now)) continue;
      out.push({ key, value: JSON.parse(e.v) as T });
      if (out.length >= limit) break;
    }
    return out;
  }

  count(ns: string): number {
    return this.data.get(ns)?.size ?? 0;
  }

  private purgeNs(ns: string): number {
    const m = this.data.get(ns);
    if (!m) return 0;
    const now = this.now();
    let n = 0;
    for (const [k, e] of m) {
      if (e.exp && e.exp <= now) {
        m.delete(k);
        n++;
      }
    }
    return n;
  }

  purgeExpired(): number {
    let n = 0;
    for (const ns of this.data.keys()) n += this.purgeNs(ns);
    return n;
  }

  close(): void {
    this.data.clear();
  }
}

export class SqliteKV implements KV {
  db: DatabaseSync;
  limits: KVLimits;
  now: () => number;
  private timer: NodeJS.Timeout;

  constructor(path: string, limits: KVLimits = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.limits = limits;
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (
        ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        expires INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      );
      CREATE INDEX IF NOT EXISTS kv_updated ON kv (ns, updated);
      CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires) WHERE expires > 0;
    `);
    this.timer = setInterval(() => this.purgeExpired(), 60_000);
    this.timer.unref();
  }

  get<T>(ns: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value, expires FROM kv WHERE ns = ? AND key = ?').get(ns, key) as { value: string; expires: number } | undefined;
    if (!row) return undefined;
    if (row.expires && row.expires <= this.now()) {
      this.delete(ns, key);
      return undefined;
    }
    return JSON.parse(row.value) as T;
  }

  set(ns: string, key: string, value: unknown, ttlSec?: number): void {
    const exists = this.db.prepare('SELECT 1 FROM kv WHERE ns = ? AND key = ?').get(ns, key);
    if (!exists) {
      const max = this.limits.perNamespace?.[ns] ?? this.limits.defaultMax;
      if (this.count(ns) >= max) {
        this.db.prepare('DELETE FROM kv WHERE ns = ? AND expires > 0 AND expires <= ?').run(ns, this.now());
        if (this.count(ns) >= max) {
          if (this.limits.noEvict?.includes(ns)) throw new StoreFullError(ns);
          this.db.prepare('DELETE FROM kv WHERE rowid = (SELECT rowid FROM kv WHERE ns = ? ORDER BY updated ASC LIMIT 1)').run(ns);
        }
      }
    }
    this.db
      .prepare('INSERT INTO kv (ns, key, value, expires, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, expires = excluded.expires, updated = excluded.updated')
      .run(ns, key, JSON.stringify(value), ttlSec ? this.now() + ttlSec * 1000 : 0, this.now());
  }

  delete(ns: string, key: string): void {
    this.db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?').run(ns, key);
  }

  list<T>(ns: string, prefix = '', limit = 1000): Array<{ key: string; value: T }> {
    const escaped = prefix.replace(/[\\%_]/g, (c) => '\\' + c);
    const rows = this.db
      .prepare("SELECT key, value FROM kv WHERE ns = ? AND key LIKE ? ESCAPE '\\' AND (expires = 0 OR expires > ?) ORDER BY updated ASC LIMIT ?")
      .all(ns, escaped + '%', this.now(), limit) as Array<{ key: string; value: string }>;
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }

  count(ns: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM kv WHERE ns = ?').get(ns) as { n: number }).n;
  }

  purgeExpired(): number {
    return Number(this.db.prepare('DELETE FROM kv WHERE expires > 0 AND expires <= ?').run(this.now()).changes);
  }

  close(): void {
    clearInterval(this.timer);
    this.db.close();
  }
}

export function openStore(path: string | undefined, limits?: KVLimits): KV {
  return path ? new SqliteKV(path, limits) : new MemoryKV(limits);
}
