/**
 * WhatsApp approvals: the agent asks Haat to send the exact approval summary to the person's
 * WhatsApp; the person opens a single-use link and taps Approve. The approval still goes through
 * ApprovalGate (same owner, latest unexpired revision, at most once).
 *
 * What the link can and cannot do:
 *   - GET shows the terms and never approves anything (link previews and scanners only GET);
 *   - POST approves, once; the token is stored hashed and is tied to one operation revision;
 *   - the agent never receives the link, only the person's WhatsApp does.
 */
import { HttpError, html, json, type Res, type Router } from '../util/http.ts';
import { logger } from '../util/log.ts';
import type { ApprovalGate, StoredResponse } from '../poppy/operations.ts';
import type { Commerce } from '../commerce/service.ts';
import type { GateContext } from '../commerce/assistant.ts';
import type { ApprovalLinks } from './links.ts';
import { whatsappNumber, type MessageProvider } from './provider.ts';

const log = logger('whatsapp');

export type WhatsAppDeps = {
  gate: ApprovalGate<GateContext>;
  commerce: Commerce;
  links: ApprovalLinks;
  provider: MessageProvider;
  base: string;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (status: number, title: string, body: string): Res =>
  html(
    status,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}pre{white-space:pre-wrap;font:inherit;background:#f6f6f6;padding:1rem;border-radius:8px}` +
      `button{font-size:1.1rem;padding:.8rem 1.4rem;border:0;border-radius:8px;background:#0a7d3c;color:#fff;width:100%}.note{color:#555;font-size:.9rem}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
    { 'referrer-policy': 'no-referrer' },
  );

const plain = (summary: string) => summary.replace(/\*\*/g, '');

/** Carries out exactly the approved terms. Throws like perform() does (OutcomeUnknownError included). */
export function performApproved(commerce: Commerce, userKey: string) {
  return async (c: GateContext, operationId: string): Promise<StoredResponse> => {
    if (c.kind === 'order') return { status: 201, body: commerce.summarizeOrder(await commerce.confirm(userKey, c.quote, undefined, operationId)) };
    return { status: 200, body: commerce.summarizeOrder(await commerce.cancel(commerce.owned(c.orderId, userKey))) };
  };
}

export type SendResult = { sent: true; expiresAt: string } | { sent: false; reason: 'not_found' | 'not_pending' | 'expired' | 'bad_phone' | 'too_many' | 'provider_error' };

/** Sends the latest terms of an operation to a WhatsApp number as a single-use link. */
export async function sendApprovalLink(d: WhatsAppDeps, o: { operationId: string; ownerKey: string; userKey: string; phone: string }): Promise<SendResult> {
  const view = d.gate.inspect(o.operationId, o.ownerKey);
  if (!view || !view.operation) return { sent: false, reason: 'not_found' };
  if (view.state !== 'pending') return { sent: false, reason: 'not_pending' };
  const expiresMs = Date.parse(view.operation.expires_at);
  if (view.expired || !(expiresMs > Date.now())) return { sent: false, reason: 'expired' };
  const to = whatsappNumber(o.phone);
  if (!to) return { sent: false, reason: 'bad_phone' };
  const ttlSec = (expiresMs - Date.now()) / 1000;
  if (!d.links.countSend(o.operationId, ttlSec)) return { sent: false, reason: 'too_many' };
  const token = d.links.create({ operationId: o.operationId, revision: view.operation.revision, ownerKey: o.ownerKey, userKey: o.userKey }, ttlSec);
  try {
    await d.provider.send({ to, summary: plain(view.operation.summary), link: `${d.base}/approve/${token}`, expiresAt: view.operation.expires_at });
  } catch (e) {
    d.links.revoke(token); // a link nobody received must not stay valid
    log.warn(`send failed: ${(e as Error).message}`);
    return { sent: false, reason: 'provider_error' };
  }
  return { sent: true, expiresAt: view.operation.expires_at };
}

export function registerApprovalPages(router: Router, d: WhatsAppDeps): void {
  router.on('GET', '/approve/:token', (req) => {
    const token = req.params.token!;
    const link = d.links.get(token);
    if (!link) return page(404, 'Link not found', '<p>This approval link is not valid. Ask your assistant to send a new one.</p>');
    const view = d.gate.inspect(link.operationId, link.ownerKey, link.revision);
    if (!view?.operation) return page(404, 'Link not found', '<p>This approval link is not valid. Ask your assistant to send a new one.</p>');
    if (link.usedAt || view.state !== 'pending') {
      if (view.state === 'performed') {
        const r = view.result?.body as { order_id?: string } | undefined;
        return page(200, 'Already approved', `<p>This was approved and is done${r?.order_id ? `. Order <b>${esc(r.order_id)}</b>` : ''}.</p>`);
      }
      if (view.state === 'performing') return page(200, 'In progress', '<p>This is being processed. Open this link again in a minute.</p>');
      return page(410, 'Link already used', '<p>This link was already used. Ask your assistant to send a new one.</p>');
    }
    if (view.expired || !view.current) return page(410, 'Terms changed or expired', '<p>These terms are no longer current. Ask your assistant to send a new approval.</p>');
    return page(
      200,
      'Approve this order?',
      `<pre>${esc(plain(view.operation.summary))}</pre><p class="note">Opening this page approves nothing. Valid until ${esc(view.operation.expires_at)}.</p>` +
        `<form method="post" action="/approve/${esc(token)}"><button type="submit">Approve</button></form>`,
    );
  });

  router.on('POST', '/approve/:token', async (req) => {
    const token = req.params.token!;
    const link = d.links.get(token);
    if (!link) return page(404, 'Link not found', '<p>This approval link is not valid. Ask your assistant to send a new one.</p>');
    const view = d.gate.inspect(link.operationId, link.ownerKey, link.revision);
    if (!view?.operation) return page(404, 'Link not found', '<p>This approval link is not valid. Ask your assistant to send a new one.</p>');
    // Single use: the first request to get here owns the approval, any other one is refused.
    if (!d.links.use(token)) return page(410, 'Link already used', '<p>This link was already used.</p>');
    let r;
    try {
      r = await d.gate.approveStored({ operation_id: link.operationId, revision: link.revision }, link.ownerKey, performApproved(d.commerce, link.userKey));
    } catch (e) {
      // A definite failure (the seller refused, or nothing was sent): nothing was ordered.
      d.links.revoke(token);
      if (e instanceof HttpError) throw e;
      log.warn(`approval failed: ${(e as Error).message}`);
      return page(502, 'Could not place the order', '<p>The seller did not accept the order and nothing was ordered. Ask your assistant to try again.</p>');
    }
    if (!r) return page(410, 'Terms changed or expired', '<p>These terms are no longer current, so nothing was ordered. Ask your assistant to send a new approval.</p>');
    if (r.kind === 'in_progress') return page(202, 'In progress', '<p>Your approval was received and the order is being confirmed with the seller. Open this link again in a minute to see the result.</p>');
    if (r.kind === 'performed') {
      const b = r.response.body as { order_id?: string; seller?: { name?: string } };
      return page(200, 'Approved', `<p>Done${b.order_id ? `. Order <b>${esc(b.order_id)}</b>` : ''}${b.seller?.name ? ` from ${esc(b.seller.name)}` : ''}.</p>`);
    }
    return page(410, 'Terms changed or expired', '<p>Nothing was ordered. Ask your assistant to send a new approval.</p>');
  });
}

export const sendResultResponse = (r: SendResult): Res => {
  if (r.sent) return json(202, { status: 'sent', channel: 'whatsapp', expires_at: r.expiresAt });
  const map = { not_found: [404, 'operation_not_found'], not_pending: [409, 'operation_not_pending'], expired: [409, 'operation_expired'], bad_phone: [400, 'invalid_phone'], too_many: [429, 'too_many_sends'], provider_error: [502, 'whatsapp_unavailable'] } as const;
  const [status, error] = map[r.reason];
  return json(status, { error }, status === 429 ? { 'retry-after': '3600' } : {});
};
