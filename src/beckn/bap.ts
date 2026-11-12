/**
 * Beckn is asynchronous: a buyer app (BAP) POSTs `/search`, gets a synchronous ACK, and the
 * answers arrive later as signed `/on_search` callbacks to its own URL. This client hides that:
 * `request()` sends the call and resolves with the matching callbacks (correlated by message_id).
 */
import { randomUUID } from 'node:crypto';
import { createAuthorizationHeader, verifyAuthorizationHeader, type SigningKey } from './signing.ts';
import type { RegistryClient } from './registry.ts';
import { ACK, nack, type BecknAction, type BecknCallback, type BecknContext, type BecknEnvelope, type BecknMessage } from './types.ts';
import { logger } from '../util/log.ts';

const log = logger('bap');

type Waiter = {
  action: BecknAction;
  transactionId: string;
  collect: boolean;
  responses: BecknEnvelope[];
  resolve: (r: BecknEnvelope[]) => void;
  timer: NodeJS.Timeout;
};

export type BapOptions = {
  key: SigningKey;
  /** Public base URL where this BAP receives callbacks; callbacks go to `${bapUri}/on_*`. */
  bapUri: string;
  gatewayUrl: string;
  registry: RegistryClient;
  domain: string;
  city: string;
  timeoutMs?: number;
};

/**
 * What we know about a failed call, which decides whether it may be retried:
 *   - not_sent: the request never reached the other side (connection refused, DNS failure);
 *   - rejected: the other side answered and refused it (a Beckn NACK, an HTTP 4xx, or an error callback);
 *   - unknown:  it may have been received and acted on (timeout, reset, 5xx without a NACK, no callback).
 * For `confirm`, only not_sent and rejected prove that no order exists.
 */
export type BecknOutcome = 'not_sent' | 'rejected' | 'unknown';

export class BecknError extends Error {
  code: string;
  outcome: BecknOutcome;
  constructor(code: string, message: string, outcome: BecknOutcome = 'unknown') {
    super(message);
    this.code = code;
    this.outcome = outcome;
  }
}

/** Errors from fetch() that prove the request body was never delivered. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function fetchFailureOutcome(e: unknown): BecknOutcome {
  const code = (e as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === 'string' && NOT_SENT_CODES.has(code) ? 'not_sent' : 'unknown';
}

/** A verified callback that matched no waiting request (late, or after a restart). */
export type UnmatchedCallbackHandler = (callback: BecknCallback, env: BecknEnvelope) => void | Promise<void>;

export class BapClient {
  opts: BapOptions;
  waiters = new Map<string, Waiter>();
  timeoutMs: number;
  /**
   * Called for callbacks that are correctly signed but no longer have a waiter, for example an
   * on_confirm that arrives after the timeout or after a restart.
   */
  onUnmatched?: UnmatchedCallbackHandler;

  constructor(opts: BapOptions) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? 6000;
  }

  context(action: BecknAction, over: Partial<BecknContext> = {}): BecknContext {
    return {
      domain: this.opts.domain,
      country: 'IND',
      city: this.opts.city,
      action,
      core_version: '1.2.0',
      bap_id: this.opts.key.subscriberId,
      bap_uri: this.opts.bapUri,
      transaction_id: randomUUID(),
      message_id: randomUUID(),
      timestamp: new Date().toISOString(),
      ttl: 'PT30S',
      ...over,
    };
  }

  /**
   * Sends a Beckn action and waits for its callbacks.
   * - collect=false: resolves with the first callback (select, init, confirm, status, cancel).
   * - collect=true: gathers callbacks until `windowMs` passes (search fans out to many sellers).
   */
  async request(
    action: BecknAction,
    message: BecknMessage,
    opts: { context?: Partial<BecknContext>; target?: string; collect?: boolean; windowMs?: number } = {},
  ): Promise<BecknEnvelope[]> {
    const context = this.context(action, opts.context);
    const body = JSON.stringify({ context, message });
    const target = (opts.target ?? this.opts.gatewayUrl).replace(/\/$/, '') + '/' + action;
    const collect = opts.collect ?? false;
    const wait = collect ? (opts.windowMs ?? 1500) : this.timeoutMs;

    const done = new Promise<BecknEnvelope[]>((resolve) => {
      const timer = setTimeout(() => {
        const w = this.waiters.get(context.message_id);
        this.waiters.delete(context.message_id);
        resolve(w?.responses ?? []);
      }, wait);
      this.waiters.set(context.message_id, { action, transactionId: context.transaction_id, collect, responses: [], resolve, timer });
    });

    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: createAuthorizationHeader(this.opts.key, body) },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch((e: Error) => {
      this.cancel(context.message_id);
      const outcome = fetchFailureOutcome(e);
      throw new BecknError(outcome === 'not_sent' ? 'not_sent' : 'network_error', `${action} to ${target} failed: ${e.message}`, outcome);
    });
    const ack = (await res.json().catch(() => null)) as { message?: { ack?: { status?: string } }; error?: { code?: string; message?: string } } | null;
    if (!res.ok || ack?.message?.ack?.status !== 'ACK') {
      this.cancel(context.message_id);
      // A NACK or a 4xx is a refusal. A 5xx without a NACK (a proxy error, a crash) may hide a
      // request the seller already processed, so it counts as unknown.
      const rejected = ack?.message?.ack?.status === 'NACK' || (res.status >= 400 && res.status < 500);
      throw new BecknError(ack?.error?.code ?? 'nack', `${action} was not acknowledged: ${ack?.error?.message ?? res.status}`, rejected ? 'rejected' : 'unknown');
    }
    const responses = await done;
    // The seller ACKed and may have acted; only its callback is missing.
    if (!collect && responses.length === 0) throw new BecknError('timeout', `no ${'on_' + action} within ${wait} ms`, 'unknown');
    return responses;
  }

  private cancel(messageId: string): void {
    const w = this.waiters.get(messageId);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(messageId);
      w.resolve([]);
    }
  }

  /** HTTP handler body for POST /beckn/on_*. Verifies the seller's signature, then ACKs. */
  async handleCallback(callback: BecknCallback, rawBody: Buffer, authorization: string | undefined): Promise<{ status: number; body: unknown }> {
    let env: BecknEnvelope;
    try {
      env = JSON.parse(rawBody.toString('utf8')) as BecknEnvelope;
    } catch {
      return { status: 400, body: nack('10000', 'invalid JSON') };
    }
    const v = await verifyAuthorizationHeader(authorization, rawBody, this.opts.registry.keyLookup());
    if (!v.ok) {
      log.warn(`rejected ${callback}: ${v.reason}`);
      return { status: 401, body: nack('10001', v.reason) };
    }
    if (env.context?.action !== callback) return { status: 400, body: nack('10002', 'context.action does not match endpoint') };
    if (env.context.bpp_id !== v.subscriberId) return { status: 401, body: nack('10001', 'signer is not context.bpp_id') };
    const w = this.waiters.get(env.context.message_id);
    if (!w || w.transactionId !== env.context.transaction_id || `on_${w.action}` !== callback) {
      log.info(`late or unknown ${callback} ${env.context.message_id}`);
      if (this.onUnmatched) {
        try {
          await this.onUnmatched(callback, env);
        } catch (e) {
          log.warn(`handling late ${callback} failed: ${(e as Error).message}`);
        }
      }
      return { status: 200, body: ACK }; // acknowledged; handed to onUnmatched, never matched to a new request
    }
    w.responses.push(env);
    if (!w.collect) {
      clearTimeout(w.timer);
      this.waiters.delete(env.context.message_id);
      w.resolve(w.responses);
    }
    return { status: 200, body: ACK };
  }
}
