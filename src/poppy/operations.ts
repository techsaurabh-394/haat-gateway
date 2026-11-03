/**
 * Poppy Operations extension, version 2 (draft 0.3):
 * https://personalagentprotocol.org/docs/0.3/extensions/operations
 *
 * The gateway uses it for every action with a business effect (placing or cancelling an ONDC
 * order). The guarantees it implements:
 *   - the User approves one exact revision of the terms, and only that revision is performed;
 *   - an operation is performed at most once, however many times its approval is sent;
 *   - while the outcome is unknown, the gateway answers 503 + Retry-After, never "failed".
 */
import { b64u, randomId, sha256, stableJson } from '../util/b64.ts';
import { DEFAULT_LIMITS, MemoryKV, type KV } from '../store/kv.ts';

export type Operation = {
  operation_id: string;
  revision: string;
  summary: string;
  terms?: Record<string, unknown>;
  expires_at: string;
};

export type Approval = { operation_id: string; revision: string };

/** A response the gateway can replay verbatim when the same approval is sent again (section 7). */
export type StoredResponse = { status: number; body: unknown };

/**
 * Parses the `Poppy-Approval` header, a Dictionary Structured Field (RFC 9651) whose
 * `operation_id` and `revision` members are Strings. Unknown members are ignored (section 6).
 * Returns null when the header is absent or malformed.
 */
export function parseApprovalHeader(value: string | undefined): Approval | null {
  if (!value) return null;
  const out: Record<string, string> = {};
  let i = 0;
  const s = value;
  const skipOws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  while (i < s.length) {
    skipOws();
    const keyMatch = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    i += key.length;
    if (s[i] === '=') {
      i++;
      if (s[i] === '"') {
        i++;
        let str = '';
        let closed = false;
        while (i < s.length) {
          const c = s[i]!;
          if (c === '\\') {
            const n = s[i + 1];
            if (n !== '"' && n !== '\\') return null;
            str += n;
            i += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            i++;
            break;
          }
          const code = c.charCodeAt(0);
          if (code < 0x20 || code > 0x7e) return null;
          str += c;
          i++;
        }
        if (!closed) return null;
        out[key] = str;
      } else {
        // Some other bare item (token, integer, ...): skip it, it is not a member we use.
        const bare = /^[^,;]*/.exec(s.slice(i))![0];
        i += bare.length;
      }
    }
    // Skip parameters, if any.
    while (s[i] === ';') {
      const p = /^;[^,;]*/.exec(s.slice(i))![0];
      i += p.length;
    }
    skipOws();
    if (i < s.length) {
      if (s[i] !== ',') return null;
      i++;
    }
  }
  if (typeof out.operation_id !== 'string' || typeof out.revision !== 'string') return null;
  return { operation_id: out.operation_id, revision: out.revision };
}

export function formatApprovalHeader(a: Approval): string {
  const q = (v: string) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return `operation_id=${q(a.operation_id)}, revision=${q(a.revision)}`;
}

type Revision<C> = { revision: string; expiresAtMs: number; fingerprint: string; context: C; operation: Operation };

/** What is stored per operation. Plain JSON, so it survives restarts in SqliteKV. */
export type OpRecord<C> = {
  operationId: string;
  ownerKey: string;
  actionKey: string;
  state: 'pending' | 'performing' | 'performed';
  revisions: Record<string, Revision<C>>;
  result?: StoredResponse;
  performedRevision?: string;
  latestRevision?: string;
  keepUntilMs: number;
};

export type Quote<C> = {
  summary: string;
  terms?: Record<string, unknown>;
  /** How long the terms can be held, seconds. */
  ttlSec: number;
  /** Whatever `perform` needs to carry out exactly these terms. Must be JSON-serialisable. */
  context: C;
};

export type GateRequest<C> = {
  /** Who may approve: the Session (signed out) or the account (signed in). Operations section 3. */
  ownerKey: string;
  /** Identifies "the same action" from the Company's records, e.g. "order:<provider>". */
  actionKey: string;
  /** Hash of exactly what this request asks for; an approval must match it (check 3). */
  fingerprint: string;
  approval: Approval | null;
  quote: () => Promise<Quote<C>>;
  perform: (context: C) => Promise<StoredResponse>;
};

export type GateResult =
  | { kind: 'performed'; response: StoredResponse; replayed: boolean }
  | { kind: 'approval_required'; operation: Operation }
  | { kind: 'in_progress'; retryAfterSec: number };

const NS = 'ops';
const NS_ACTION = 'op_action';
/** Performed operations are remembered at least this long after their revision expires (section 7). */
const REMEMBER_AFTER_EXPIRY_MS = 24 * 3600 * 1000;

export class ApprovalGate<C> {
  kv: KV;
  now: () => number;
  /** How long to wait for `perform` before answering 503 (outcome unknown). */
  performTimeoutMs: number;
  idPrefix: string;
  /** Operations being performed by THIS process. A stored 'performing' state without an entry here
   *  was interrupted by a restart: its outcome is unknown, so it keeps answering 503 (section 7). */
  inflight = new Map<string, Promise<StoredResponse>>();

  constructor(opts: { kv?: KV; now?: () => number; performTimeoutMs?: number; idPrefix?: string } = {}) {
    this.now = opts.now ?? Date.now;
    this.kv = opts.kv ?? new MemoryKV(DEFAULT_LIMITS, this.now);
    this.performTimeoutMs = opts.performTimeoutMs ?? 8000;
    this.idPrefix = opts.idPrefix ?? 'op_';
  }

  static fingerprint(v: unknown): string {
    return b64u(sha256(stableJson(v))).slice(0, 22);
  }

  get(operationId: string): OpRecord<C> | undefined {
    return this.kv.get<OpRecord<C>>(NS, operationId);
  }

  private save(rec: OpRecord<C>): void {
    const ttlSec = Math.max(60, Math.ceil((rec.keepUntilMs - this.now()) / 1000));
    this.kv.set(NS, rec.operationId, rec, ttlSec);
    this.kv.set(NS_ACTION, `${rec.ownerKey}\n${rec.actionKey}`, rec.operationId, ttlSec);
  }

  async handle(req: GateRequest<C>): Promise<GateResult> {
    if (req.approval) {
      const rec = this.get(req.approval.operation_id);
      // Check 1: the Session/account can approve this operation. Otherwise: as if no approval.
      if (rec && rec.ownerKey === req.ownerKey && rec.actionKey === req.actionKey) {
        // Check 2: already performed, or being performed.
        if (rec.state === 'performed') return { kind: 'performed', response: rec.result!, replayed: true };
        if (rec.state === 'performing') return { kind: 'in_progress', retryAfterSec: 2 };
        // Check 3: a revision we returned, unexpired, and the request asks for exactly it.
        const rev = rec.revisions[req.approval.revision];
        if (rev && rev.expiresAtMs > this.now() && rev.fingerprint === req.fingerprint) {
          return this.perform(rec, rev, req.perform);
        }
        // Check 3 failed: perform nothing, return a NEW revision for what the request asks.
        return { kind: 'approval_required', operation: await this.requote(rec, req, req.approval.revision) };
      }
    }
    // No (usable) approval: return an operation, reusing the operation_id for the same action.
    const existingId = this.kv.get<string>(NS_ACTION, `${req.ownerKey}\n${req.actionKey}`);
    const existing = existingId ? this.get(existingId) : undefined;
    if (existing && existing.state !== 'performed') {
      if (existing.state === 'performing') return { kind: 'in_progress', retryAfterSec: 2 };
      return { kind: 'approval_required', operation: await this.requote(existing, req) };
    }
    const rec: OpRecord<C> = {
      operationId: randomId(this.idPrefix, 9),
      ownerKey: req.ownerKey,
      actionKey: req.actionKey,
      state: 'pending',
      revisions: {},
      keepUntilMs: this.now() + 3600_000,
    };
    return { kind: 'approval_required', operation: await this.requote(rec, req) };
  }

  /** Latest operation for an owner's action, if any (used by conversations). */
  pending(ownerKey: string, actionKey: string): Operation | undefined {
    const id = this.kv.get<string>(NS_ACTION, `${ownerKey}\n${actionKey}`);
    const rec = id ? this.get(id) : undefined;
    if (!rec || rec.state !== 'pending' || !rec.latestRevision) return undefined;
    return rec.revisions[rec.latestRevision]?.operation;
  }

  private async requote(rec: OpRecord<C>, req: GateRequest<C>, mustDifferFrom?: string): Promise<Operation> {
    const q = await req.quote();
    const expiresAtMs = this.now() + q.ttlSec * 1000;
    let revision: string;
    do {
      // Opaque, unique per set of terms: a new revision whenever summary, terms or expiry change.
      const digest = b64u(sha256(stableJson({ s: q.summary, t: q.terms, e: expiresAtMs, n: randomId('', 6) }))).slice(0, 12);
      revision = `${Math.floor(expiresAtMs / 1000)}-${digest}`;
    } while (revision === mustDifferFrom || rec.revisions[revision]);
    const operation: Operation = {
      operation_id: rec.operationId,
      revision,
      summary: q.summary,
      ...(q.terms ? { terms: q.terms } : {}),
      expires_at: new Date(expiresAtMs).toISOString(),
    };
    rec.revisions[revision] = { revision, expiresAtMs, fingerprint: req.fingerprint, context: q.context, operation };
    rec.latestRevision = revision;
    rec.keepUntilMs = Math.max(rec.keepUntilMs, expiresAtMs + REMEMBER_AFTER_EXPIRY_MS);
    // Drop long-expired revisions we no longer need.
    for (const [k, r] of Object.entries(rec.revisions)) {
      if (r.expiresAtMs < this.now() - 60_000 && k !== rec.performedRevision && k !== rec.latestRevision) delete rec.revisions[k];
    }
    this.save(rec);
    return operation;
  }

  private async perform(rec: OpRecord<C>, rev: Revision<C>, perform: (c: C) => Promise<StoredResponse>): Promise<GateResult> {
    rec.state = 'performing';
    rec.performedRevision = rev.revision;
    this.save(rec); // persisted BEFORE the action, so a crash leaves "performing", never "pending"
    const task = perform(rev.context).then(
      (response) => {
        rec.state = 'performed';
        rec.result = response;
        this.save(rec);
        return response;
      },
      (err: unknown) => {
        // A definite failure: nothing was performed, so the operation can be approved again.
        rec.state = 'pending';
        rec.performedRevision = undefined;
        this.save(rec);
        throw err;
      },
    ).finally(() => this.inflight.delete(rec.operationId));
    this.inflight.set(rec.operationId, task);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.performTimeoutMs);
    });
    try {
      const winner = await Promise.race([task, timeout]);
      if (winner === 'timeout') {
        task.catch(() => undefined); // settles later and updates the record
        return { kind: 'in_progress', retryAfterSec: 3 };
      }
      return { kind: 'performed', response: winner, replayed: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
