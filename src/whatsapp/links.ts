/**
 * Single-use approval links. The link carries a random token; only its SHA-256 is stored, so a
 * leaked database does not leak usable links. A link is tied to ONE operation revision and to the
 * owner who asked for it, and it never approves anything by itself: opening it only shows the
 * terms, and approving needs a separate POST.
 */
import { b64u, randomId, sha256 } from '../util/b64.ts';
import type { KV } from '../store/kv.ts';

const NS = 'wa_links';
const NS_SENDS = 'wa_sends';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const MAX_SENDS_PER_OPERATION = 3;

export type LinkRecord = {
  operationId: string;
  revision: string;
  ownerKey: string;
  /** Who the order belongs to (the account), used when the order is placed. */
  userKey: string;
  createdAt: string;
  usedAt?: string;
};

export class ApprovalLinks {
  kv: KV;
  constructor(kv: KV) {
    this.kv = kv;
  }

  private key(token: string): string {
    return b64u(sha256(token));
  }

  /** Creates a link token valid for `ttlSec` seconds. The raw token is returned once and never stored. */
  create(rec: Omit<LinkRecord, 'createdAt' | 'usedAt'>, ttlSec: number): string {
    const token = randomId('', 32); // 32 random bytes -> 43 base64url characters
    this.kv.set(NS, this.key(token), { ...rec, createdAt: new Date().toISOString() } satisfies LinkRecord, Math.max(60, Math.ceil(ttlSec)));
    return token;
  }

  get(token: string): LinkRecord | undefined {
    if (!TOKEN_RE.test(token)) return undefined;
    return this.kv.get<LinkRecord>(NS, this.key(token));
  }

  /**
   * Marks the link as used. Returns true only for the first call; this runs synchronously, so two
   * simultaneous requests cannot both get true.
   */
  use(token: string, ttlSec = 24 * 3600): boolean {
    const rec = this.get(token);
    if (!rec || rec.usedAt) return false;
    this.kv.set(NS, this.key(token), { ...rec, usedAt: new Date().toISOString() } satisfies LinkRecord, ttlSec);
    return true;
  }

  revoke(token: string): void {
    this.kv.delete(NS, this.key(token));
  }

  /** Counts a send for an operation; false once MAX_SENDS_PER_OPERATION is reached. */
  countSend(operationId: string, ttlSec: number): boolean {
    const n = this.kv.get<number>(NS_SENDS, operationId) ?? 0;
    if (n >= MAX_SENDS_PER_OPERATION) return false;
    this.kv.set(NS_SENDS, operationId, n + 1, Math.max(60, Math.ceil(ttlSec)));
    return true;
  }
}
