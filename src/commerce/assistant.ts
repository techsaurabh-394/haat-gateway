/**
 * The Company Agent behind Poppy conversations (spec section 8).
 *
 * It is deliberately rule-based: every reply is deterministic and testable, and no LLM ever sees
 * tokens, keys or the approval step. Swapping in a local open-weight model for intent detection
 * is on the roadmap; the approval and ordering logic would stay here, outside the model.
 */
import { ApprovalGate, type Approval, type Operation } from '../poppy/operations.ts';
import type { Conversation, ConversationStore, Message } from '../poppy/conversations.ts';
import { normalizeText } from '../lexicon/normalize.ts';
import { CommerceError, describeBasket, validateCart, type CartRequest, type Delivery, type QuoteContext, type SearchResult } from './service.ts';
import type { Basket } from './basket.ts';
import type { StoredOrder , Commerce} from './service.ts';
import type { OAuthServer, TokenInfo } from '../oauth/server.ts';

export type AuthContext = { token: TokenInfo | null; accountKey?: string; userKey: string; operations: boolean };

type Memory = {
  search?: SearchResult;
  delivery?: Delivery;
  cart?: CartRequest;
  lastOrderId?: string;
};

export type GateContext = { kind: 'order'; quote: QuoteContext } | { kind: 'cancel'; orderId: string };

const ORDER_RE = /\b(order|place|confirm|book|buy|checkout|kar ?do|kardo|karo|mangwa ?do|mangwao|le lo|haan|ha|yes|ok|okay|theek)\b|ऑर्डर|हाँ|हां|मंगवा/;
const STATUS_RE = /\b(status|track|kahan|kaha|where|kab|when)\b|कहाँ|कब|स्थिति/;
const CANCEL_RE = /\b(cancel|radd|band karo|mat bhejo)\b|रद्द|कैंसल/;
const MY_ORDERS_RE = /\b(my orders|mere orders|order history|purane orders?|pichhle orders?)\b|मेरे ऑर्डर/;
const HELLO_RE = /^(hi|hello|namaste|namaskar|hey|नमस्ते)\b/;

function hindi(c: Conversation): boolean {
  return String(c.context.locale ?? '').toLowerCase().startsWith('hi');
}

export function cartFromBasket(b: Basket, delivery: Delivery): CartRequest {
  return validateCart({
    bpp_id: b.bppId,
    provider_id: b.providerId,
    items: b.lines.map((l) => ({ id: l.offer.itemId, count: l.count })),
    delivery,
  });
}

export class Assistant {
  commerce: Commerce;
  gate: ApprovalGate<GateContext>;
  store: ConversationStore;
  oauth?: OAuthServer;

  constructor(commerce: Commerce, gate: ApprovalGate<GateContext>, store: ConversationStore, oauth?: OAuthServer) {
    this.commerce = commerce;
    this.gate = gate;
    this.store = store;
    this.oauth = oauth;
  }

  /** A saved address, when signed in with the addresses scope (used if no delivery was given). */
  private savedDelivery(auth: AuthContext): Delivery | undefined {
    if (!this.oauth || !auth.token?.scopes.includes('addresses')) return undefined;
    const account = this.oauth.account(auth.token.accountId);
    const a = account?.addresses[0];
    if (!account || !a) return undefined;
    const { id: _id, label: _l, contact_name, contact_phone, ...address } = a;
    return { name: contact_name ?? 'Customer', phone: contact_phone ?? account.phone, address };
  }

  /** 8.11: when an action needs the account, add an authorization event and say so. */
  private needSignIn(c: Conversation, scope: string, why: string): void {
    this.store.authorizationNeeded(c, scope);
    this.store.companyMessage(c, { text: why });
  }

  /** Handles one message from the Personal Agent and writes the Company's reply events. */
  async handle(c: Conversation, msg: Message, auth: AuthContext): Promise<void> {
    const userKey = auth.userKey;
    const mem = c.memory as Memory;
    const reply = (text: string, extra: Partial<Message> = {}) => this.store.companyMessage(c, { text, ...extra });
    try {
      if (msg.data && typeof msg.data.delivery === 'object') {
        mem.delivery = msg.data.delivery as Delivery;
      }
      if (msg.approval) return auth.operations ? await this.approve(c, msg.approval, auth) : this.noOperations(c);
      const text = msg.text ? normalizeText(msg.text) : '';
      if (!text) {
        if (mem.delivery && mem.search?.basket && msg.data?.delivery) return await this.proposeOrder(c, auth);
        return; // a context-only update needs no reply (8.4)
      }
      if (HELLO_RE.test(text) && text.split(/\s+/).length <= 2) {
        return reply(hindi(c)
          ? 'नमस्ते! क्या मंगवाना है? जैसे: "2 किलो आटा और 1 लीटर दूध"'
          : 'Namaste! Tell me what to get, for example "2 kilo atta aur 1 litre doodh".');
      }
      if (MY_ORDERS_RE.test(text)) return await this.myOrders(c, auth);
      if (CANCEL_RE.test(text)) return auth.operations ? await this.proposeCancel(c, userKey) : this.noOperations(c);
      if (STATUS_RE.test(text) && mem.lastOrderId) return await this.status(c, userKey);
      if (ORDER_RE.test(text) && mem.search?.basket && this.commerce.parse(msg.text!).every((t) => !t.matched)) {
        return await this.proposeOrder(c, auth);
      }
      return await this.search(c, msg.text!);
    } catch (e) {
      if (e instanceof CommerceError) {
        reply(`I couldn't do that: ${e.message}.`, { data: { error: e.code } });
        return;
      }
      throw e;
    }
  }

  private async search(c: Conversation, text: string): Promise<void> {
    const mem = c.memory as Memory;
    const result = await this.commerce.search(text);
    mem.search = result;
    mem.cart = undefined;
    const b = result.basket;
    if (!b) {
      this.store.companyMessage(c, {
        text: hindi(c) ? 'माफ़ कीजिए, आस-पास किसी विक्रेता के पास ये चीज़ें नहीं मिलीं।' : 'No nearby seller on the network has these items right now.',
        data: { understood: result.terms },
      });
      return;
    }
    const ask = hindi(c)
      ? mem.delivery
        ? 'अंतिम कोटेशन के लिए "order" कहें।'
        : 'अंतिम कोटेशन के लिए `data.delivery` में डिलीवरी विवरण भेजें (नाम, फ़ोन, PIN वाला पता), फिर "order" कहें।'
      : mem.delivery
        ? 'Say "order" to get the final quote for approval.'
        : 'To get the final quote, send delivery details in `data.delivery` (name, phone, address with PIN), then say "order".';
    this.store.companyMessage(c, {
      text: `${describeBasket(b, result.terms, c.context.locale as string | undefined)}\n\n${ask}`,
      data: {
        understood: result.terms,
        basket: {
          seller: { bpp_id: b.bppId, provider_id: b.providerId, name: b.providerName },
          lines: b.lines.map((l) => ({ item_id: l.offer.itemId, name: l.offer.name, count: l.count, unit_price: l.offer.price.toFixed(2), line_total: l.lineTotal.toFixed(2) })),
          missing: b.missing,
          items_total: b.itemsTotal.toFixed(2),
        },
      },
    });
  }

  private async myOrders(c: Conversation, auth: AuthContext): Promise<void> {
    if (!auth.token) return this.needSignIn(c, 'orders:read', 'To see your past orders, sign in to your account.');
    if (!auth.token.scopes.includes('orders:read')) return this.needSignIn(c, 'orders:read', 'Seeing your orders needs the orders:read permission.');
    const orders = this.commerce.ordersOf(auth.userKey).slice(-5).map((o) => this.commerce.summarizeOrder(o));
    this.store.companyMessage(c, {
      text: orders.length ? orders.map((o) => `- ${o.order_id} (${o.seller.name}): ₹${o.total.amount}, ${o.fulfillment_state ?? o.state}`).join('\n') : 'You have no orders yet.',
      data: { orders },
    });
  }

  private noOperations(c: Conversation): void {
    this.store.companyMessage(c, {
      text: 'I can search and compare, but placing or cancelling an order needs your approval through the Operations extension, which your assistant does not support. Nothing was ordered.',
      data: { extension_required: 'operations' },
    });
  }

  private async proposeOrder(c: Conversation, auth: AuthContext): Promise<void> {
    if (!auth.operations) return this.noOperations(c);
    const userKey = auth.userKey;
    const mem = c.memory as Memory;
    if (auth.token && !auth.token.scopes.includes('orders:write')) {
      return this.needSignIn(c, 'orders:write', 'Placing an order in your account needs the orders:write permission.');
    }
    if (!mem.delivery) {
      const saved = this.savedDelivery(auth);
      if (saved) mem.delivery = saved;
    }
    const b = mem.search?.basket;
    if (!b) {
      this.store.companyMessage(c, { text: 'Tell me what to order first.' });
      return;
    }
    if (!mem.delivery) {
      this.store.companyMessage(c, {
        text: 'Where should it be delivered? Send `data.delivery` with name, phone (10 digits) and address (city, state, area_code PIN).',
        data: { needs: ['delivery.name', 'delivery.phone', 'delivery.address.city', 'delivery.address.state', 'delivery.address.area_code'] },
      });
      return;
    }
    mem.cart = cartFromBasket(b, mem.delivery);
    const op = await this.gateFor(c, userKey, mem.cart, null);
    if ('operation' in op) {
      this.store.companyMessage(c, {
        text: hindi(c) ? 'यह रहा अंतिम कोटेशन। आपकी मंज़ूरी मिलते ही ऑर्डर कर दूँगा।' : "Here is the final quote. I'll place the order once you approve it.",
        operation: op.operation,
      });
    }
  }

  private async gateFor(c: Conversation, userKey: string, cart: CartRequest, approval: Approval | null): Promise<{ operation: Operation } | { order: StoredOrder } | { pending: true }> {
    const locale = c.context.locale as string | undefined;
    const r = await this.gate.handle({
      ownerKey: `conv:${c.id}`,
      actionKey: 'order',
      fingerprint: ApprovalGate.fingerprint(cart),
      approval,
      quote: async () => {
        const q = await this.commerce.quote(cart, locale);
        return { summary: q.summary, terms: q.terms, ttlSec: q.ttlSec, context: { kind: 'order', quote: q.context } };
      },
      perform: async (ctx) => {
        if (ctx.kind !== 'order') throw new Error('wrong operation kind');
        const o = await this.commerce.confirm(userKey, ctx.quote);
        return { status: 201, body: this.commerce.summarizeOrder(o) };
      },
    });
    if (r.kind === 'approval_required') return { operation: r.operation };
    if (r.kind === 'in_progress') return { pending: true };
    const id = (r.response.body as { order_id: string }).order_id;
    return { order: this.commerce.owned(id, userKey) };
  }

  private async approve(c: Conversation, approval: Approval, auth: AuthContext): Promise<void> {
    const userKey = auth.userKey;
    const mem = c.memory as Memory;
    // A cancel approval?
    if (mem.lastOrderId && this.gate.get(approval.operation_id)?.actionKey === `cancel:${mem.lastOrderId}`) {
      return this.proposeCancel(c, userKey, approval);
    }
    if (!mem.cart) {
      this.store.companyMessage(c, { text: 'There is no order waiting for approval in this conversation.' });
      return;
    }
    const r = await this.gateFor(c, userKey, mem.cart, approval);
    if ('pending' in r) {
      this.store.companyMessage(c, { text: 'The seller is still confirming. Send the same approval again in a few seconds; it will not be ordered twice.' });
    } else if ('operation' in r) {
      this.store.companyMessage(c, { text: 'That approval no longer matches the quote (it changed or expired). Here are the current terms.', operation: r.operation });
    } else {
      mem.lastOrderId = r.order.id;
      const s = this.commerce.summarizeOrder(r.order);
      this.store.companyMessage(c, {
        text: hindi(c)
          ? `ऑर्डर हो गया: **${s.order_id}** (${s.seller.name})। कुल ₹${s.total.amount}, डिलीवरी पर भुगतान।`
          : `Order placed: **${s.order_id}** with ${s.seller.name}. Total ₹${s.total.amount}, paid on delivery. Ask "status" any time.`,
        data: { order: s },
      });
    }
  }

  private async status(c: Conversation, userKey: string): Promise<void> {
    const mem = c.memory as Memory;
    const o = await this.commerce.status(mem.lastOrderId!, userKey);
    const s = this.commerce.summarizeOrder(o);
    this.store.companyMessage(c, { text: `Order ${s.order_id}: ${s.fulfillment_state ?? s.state}.`, data: { order: s } });
  }

  private async proposeCancel(c: Conversation, userKey: string, approval: Approval | null = null): Promise<void> {
    const mem = c.memory as Memory;
    if (!mem.lastOrderId) {
      this.store.companyMessage(c, { text: 'There is no order in this conversation to cancel.' });
      return;
    }
    const orderId = mem.lastOrderId;
    const current = await this.commerce.status(orderId, userKey);
    const r = await this.gate.handle({
      ownerKey: `conv:${c.id}`,
      actionKey: `cancel:${orderId}`,
      fingerprint: ApprovalGate.fingerprint({ cancel: orderId }),
      approval,
      quote: async () => ({ ...this.commerce.cancelQuote(current, c.context.locale as string | undefined), context: { kind: 'cancel', orderId } }),
      perform: async () => {
        const o = await this.commerce.cancel(this.commerce.owned(orderId, userKey));
        return { status: 200, body: this.commerce.summarizeOrder(o) };
      },
    });
    if (r.kind === 'approval_required') this.store.companyMessage(c, { text: 'Cancelling needs your approval.', operation: r.operation });
    else if (r.kind === 'in_progress') this.store.companyMessage(c, { text: 'Cancellation is in progress. Send the same approval again shortly.' });
    else this.store.companyMessage(c, { text: `Order ${orderId} is ${(r.response.body as { state?: string }).state}.`, data: { order: r.response.body } });
  }
}
