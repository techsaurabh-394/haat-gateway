/**
 * Poppy conversations, draft 0.3 section 8: ordered events, opaque cursors, long polling with
 * `wait`, message-ID idempotency per User, status/responder, handoff and close.
 * The Company Agent that writes replies lives in src/commerce/assistant.ts.
 */
import { randomId, stableJson } from '../util/b64.ts';
import { HttpError } from '../util/http.ts';
import { MemoryKV, type KV } from '../store/kv.ts';

export type Author = { type: 'agent' | 'human'; id?: string; name?: string; image?: string };

export type Message = {
  id: string;
  role?: 'user' | 'company';
  author: Author;
  text?: string;
  data?: Record<string, unknown>;
  context?: Record<string, unknown>;
  operation?: unknown;
  approval?: { operation_id: string; revision: string };
};

export type Status = 'working' | 'idle' | 'queued' | 'closed';
export type Responder = 'agent' | 'human';

export type ConvEvent =
  | { id: string; type: 'message'; created_at: string; message: Message }
  | { id: string; type: 'state'; created_at: string; status: Status; responder: Responder }
  | { id: string; type: 'authorization'; created_at: string; error: string; scope: string };
export type { ConvEvent as ConversationEvent };

export type Conversation = {
  id: string;
  /** Random per conversation, part of every event ID so foreign cursors are recognised (8.13). */
  tag: string;
  /** Sequence number of the last event, and of the first event still kept. */
  seq: number;
  firstSeq: number;
  ownerKey: string; // client_id + User ID (spec 8.2)
  events: ConvEvent[];
  status: Status;
  responder: Responder;
  context: Record<string, unknown>;
  /** Company Agent memory for this conversation (search results, basket, delivery details). */
  memory: Record<string, unknown>;
  waiters: Set<() => void>;
  listeners: Set<(e: ConvEvent) => void>;
  createdAt: number;
  updatedAt: number;
};

export const MAX_WAIT_SEC = 25;

export function conversationError(status: number, error: string, description?: string): HttpError {
  return new HttpError(status, { error, ...(description ? { error_description: description } : {}) });
}

export function validateIncomingMessage(m: unknown): Message {
  const msg = m as Message;
  if (!msg || typeof msg !== 'object') throw conversationError(400, 'invalid_request', 'message must be an object');
  if (typeof msg.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(msg.id)) throw conversationError(400, 'invalid_request', 'message.id must be 1-256 URL-safe base64 characters');
  if (!msg.author || (msg.author.type !== 'agent' && msg.author.type !== 'human')) throw conversationError(400, 'invalid_request', 'message.author.type must be agent or human');
  const hasContent = typeof msg.text === 'string' || (msg.data && typeof msg.data === 'object') || (msg.context && typeof msg.context === 'object') || (msg.approval && typeof msg.approval === 'object');
  if (!hasContent) throw conversationError(400, 'invalid_request', 'message needs text, data, context or approval');
  if (typeof msg.text === 'string' && msg.text.length > 4000) throw conversationError(400, 'invalid_request', 'message.text is too long');
  // Only these fields come from the Personal Agent; role is set by the Company (8.4).
  const clean: Message = { id: msg.id, author: { type: msg.author.type } };
  if (typeof msg.text === 'string') clean.text = msg.text;
  if (msg.data && typeof msg.data === 'object') clean.data = msg.data;
  if (msg.context && typeof msg.context === 'object') clean.context = msg.context;
  if (msg.approval && typeof msg.approval === 'object') {
    const a = msg.approval;
    if (typeof a.operation_id !== 'string' || typeof a.revision !== 'string') throw conversationError(400, 'invalid_request', 'approval needs operation_id and revision');
    clean.approval = { operation_id: a.operation_id, revision: a.revision };
  }
  return clean;
}

type SeenMessage = { contentHash: string; conversationId: string; response: { status: number; body: Record<string, unknown> } };

/** Stored form of a conversation (no live waiters). */
type StoredConversation = Omit<Conversation, 'waiters' | 'listeners'>;

export type StoreLimits = {
  /** Events kept per conversation; older ones are dropped and their cursors expire (8.5). */
  maxEvents: number;
  /** Conversations kept as live objects in memory; the rest are loaded from storage on demand. */
  maxLive: number;
  /** How long an idle conversation and its message IDs are kept, seconds. */
  ttlSec: number;
};

const DEFAULTS: StoreLimits = { maxEvents: 500, maxLive: 2000, ttlSec: 30 * 24 * 3600 };

export class ConversationStore {
  kv: KV;
  limits: StoreLimits;
  live = new Map<string, Conversation>();

  constructor(kv?: KV, limits: Partial<StoreLimits> = {}) {
    this.kv = kv ?? new MemoryKV();
    this.limits = { ...DEFAULTS, ...limits };
  }

  create(ownerKey: string): Conversation {
    const c: Conversation = {
      id: randomId('cnv_', 9),
      tag: randomId('', 4).replace(/[-_]/g, 'x'),
      seq: 0,
      firstSeq: 1,
      ownerKey,
      events: [],
      status: 'working',
      responder: 'agent',
      context: {},
      memory: {},
      waiters: new Set(),
      listeners: new Set(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.remember_(c);
    this.persist(c);
    return c;
  }

  private remember_(c: Conversation): void {
    this.live.delete(c.id);
    this.live.set(c.id, c);
    while (this.live.size > this.limits.maxLive) {
      // Evict the least recently used conversation that nobody is waiting on.
      const victim = [...this.live.values()].find((x) => x.waiters.size === 0 && x.listeners.size === 0);
      if (!victim) break;
      this.live.delete(victim.id);
    }
  }

  persist(c: Conversation): void {
    const { waiters: _w, listeners: _l, ...stored } = c;
    this.kv.set('conv', c.id, stored, this.limits.ttlSec);
  }

  get(id: string, ownerKey: string): Conversation {
    let c = this.live.get(id);
    if (!c) {
      const stored = this.kv.get<StoredConversation>('conv', id);
      if (stored) {
        c = { ...stored, waiters: new Set(), listeners: new Set() };
        this.remember_(c);
      }
    }
    if (!c || c.ownerKey !== ownerKey) throw conversationError(404, 'conversation_not_found');
    this.remember_(c);
    return c;
  }

  ownerOf(id: string): string | undefined {
    return this.live.get(id)?.ownerKey ?? this.kv.get<StoredConversation>('conv', id)?.ownerKey;
  }

  /** Checks idempotency: same ID + same content returns the original response; different content conflicts. */
  replay(ownerKey: string, msg: Message): SeenMessage['response'] | null {
    const seen = this.kv.get<SeenMessage>('msgseen', `${ownerKey}\n${msg.id}`);
    if (!seen) return null;
    if (seen.contentHash !== stableJson(msg)) throw conversationError(409, 'message_id_conflict', 'this message ID was already used with different content');
    return seen.response;
  }

  remember(ownerKey: string, msg: Message, conversationId: string, response: SeenMessage['response']): void {
    this.kv.set('msgseen', `${ownerKey}\n${msg.id}`, { contentHash: stableJson(msg), conversationId, response }, this.limits.ttlSec);
  }

  private push(c: Conversation, e: ConvEvent): void {
    c.events.push(e);
    if (c.events.length > this.limits.maxEvents) {
      const drop = c.events.length - this.limits.maxEvents;
      c.events.splice(0, drop);
      c.firstSeq += drop;
    }
    c.updatedAt = Date.now();
    this.persist(c);
    for (const w of c.waiters) w();
    c.waiters.clear();
    for (const l of c.listeners) l(e);
  }

  private nextEventId(c: Conversation): string {
    c.seq += 1;
    return `evt_${c.seq.toString(36)}_${c.tag}`;
  }

  addMessage(c: Conversation, role: 'user' | 'company', m: Message): void {
    if (role === 'user' && m.context) c.context = { ...c.context, ...m.context };
    this.push(c, { id: this.nextEventId(c), type: 'message', created_at: new Date().toISOString(), message: { ...m, role } });
  }

  companyMessage(c: Conversation, m: Omit<Message, 'id' | 'role' | 'author'> & { author?: Author }): void {
    this.addMessage(c, 'company', { id: randomId('msg_', 9), author: m.author ?? { type: 'agent', id: 'haat_assistant', name: 'Haat assistant' }, ...m });
  }

  authorizationNeeded(c: Conversation, scope: string): void {
    this.push(c, { id: this.nextEventId(c), type: 'authorization', created_at: new Date().toISOString(), error: 'insufficient_scope', scope });
  }

  setState(c: Conversation, status: Status, responder: Responder = c.responder): void {
    if (c.status === status && c.responder === responder) return;
    c.status = status;
    c.responder = responder;
    this.push(c, { id: this.nextEventId(c), type: 'state', created_at: new Date().toISOString(), status, responder });
  }

  /**
   * Index of the first event after `cursor`. 8.13: a cursor that isn't this conversation's is
   * invalid_cursor (400); one whose events were dropped is cursor_expired (410).
   */
  indexAfter(c: Conversation, cursor: string | undefined): number {
    if (!cursor) return 0;
    const m = /^evt_([0-9a-z]+)_([A-Za-z0-9]+)$/.exec(cursor);
    if (!m || m[2] !== c.tag) throw conversationError(400, 'invalid_cursor');
    const seq = parseInt(m[1]!, 36);
    if (seq > c.seq) throw conversationError(400, 'invalid_cursor');
    if (seq < c.firstSeq - 1) throw conversationError(410, 'cursor_expired', 'read again without a cursor');
    return seq - c.firstSeq + 1;
  }

  /** Reads events after `cursor`, holding up to `waitSec` for new ones (8.5). */
  async read(c: Conversation, cursor: string | undefined, waitSec: number, limit = 100): Promise<Record<string, unknown>> {
    let from = this.indexAfter(c, cursor);
    if (from >= c.events.length && waitSec > 0 && c.status !== 'closed') {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          c.waiters.delete(wake);
          resolve();
        }, Math.min(waitSec, MAX_WAIT_SEC) * 1000);
        c.waiters.add(wake);
      });
      from = this.indexAfter(c, cursor);
    }
    const events = c.events.slice(from, from + limit);
    return {
      conversation_id: c.id,
      events,
      cursor: events.length ? events[events.length - 1]!.id : (cursor ?? null),
      has_more: from + events.length < c.events.length,
      status: c.status,
      responder: c.responder,
    };
  }

  /** Subscribes to new events (for SSE, 8.6). Returns an unsubscribe function. */
  subscribe(c: Conversation, fn: (e: ConvEvent) => void): () => void {
    c.listeners.add(fn);
    return () => c.listeners.delete(fn);
  }

  close(c: Conversation): void {
    if (c.status !== 'closed') this.setState(c, 'closed');
  }
}

/** 8.13: `wait` must be a whole number of seconds, 0 or more. */
export function parseWait(v: string | null): number {
  if (v === null || v === '') return 0;
  if (!/^\d+$/.test(v)) throw conversationError(400, 'invalid_request', 'wait must be a whole number of seconds');
  return Number(v);
}
