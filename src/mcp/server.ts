/**
 * Haat as an MCP server (stdio). Add it to Claude, ChatGPT-compatible clients or any MCP client,
 * then say "do kilo aata" and approve on your own screen.
 *
 * The approval rule is unchanged: the gateway answers `approval_required`, the person is asked
 * through MCP elicitation (the client's own dialog, not a model message), and only a person's
 * "accept" repeats the request with that exact operation and revision. The model never sees
 * Session JWTs, keys or the approval itself. If the client cannot elicit, nothing is ordered.
 */
import type { PersonalAgent, Company } from '../../agent/personal-agent.ts';
import type { Operation } from '../poppy/operations.ts';
import { McpServer } from './protocol.ts';
import type { Tool, ToolContext, ToolResult } from './protocol.ts';

export type Delivery = Record<string, unknown>;

export const DEMO_DELIVERY: Delivery = {
  name: 'Demo Person',
  phone: '9876543210',
  address: { building: 'B-12', street: 'Durgakund Road', locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' },
  gps: '25.2783,82.9997',
};

type Basket = { bpp_id: string; provider_id: string; provider_name: string; items: { id: string; count: number }[] };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export class HaatMcp {
  private agent: PersonalAgent;
  private company?: Company;
  private sid: string;
  private baskets = new Map<string, Basket>();
  private seq = 0;
  private delivery: Delivery;
  private gatewayUrl: string;

  constructor(opts: { agent: PersonalAgent; gatewayUrl: string; delivery?: Delivery }) {
    this.agent = opts.agent;
    this.gatewayUrl = opts.gatewayUrl;
    this.delivery = opts.delivery ?? DEMO_DELIVERY;
    this.sid = opts.agent.newSession();
  }

  private async co(): Promise<Company> {
    this.company ??= await this.agent.discover(this.gatewayUrl);
    return this.company;
  }

  tools(): Tool[] {
    return [
      {
        name: 'search_groceries',
        description:
          'Search Indian grocery sellers. Accepts Hindi, Hinglish and other Indian languages, e.g. "do kilo aata, ek litre doodh". Returns what was understood, offers, and a suggested basket with a basket_id. Never orders anything.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What the person wants, in any supported language' } }, required: ['query'] },
        annotations: { readOnlyHint: true, openWorldHint: true },
        run: (a) => this.search(String(a.query ?? '')),
      },
      {
        name: 'place_order',
        description:
          'Order a basket returned by search_groceries. The PERSON is asked to approve the exact order on their own screen; you cannot approve for them. If they decline or the client cannot ask them, nothing is ordered.',
        inputSchema: { type: 'object', properties: { basket_id: { type: 'string', description: 'basket_id from search_groceries' } }, required: ['basket_id'] },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
        run: (a, ctx) => this.order(String(a.basket_id ?? ''), ctx),
      },
      {
        name: 'order_status',
        description: 'Check the status of an order placed earlier.',
        inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
        annotations: { readOnlyHint: true },
        run: (a) => this.status(String(a.order_id ?? '')),
      },
    ];
  }

  private async search(q: string): Promise<ToolResult> {
    if (!q.trim()) return text('Give a search query.', true);
    const company = await this.co();
    const r = await this.agent.call(company, this.sid, 'GET', `/api/v1/search?q=${encodeURIComponent(q)}`);
    if (r.status !== 200) return text(`Search failed (HTTP ${r.status}): ${JSON.stringify(r.body)}`, true);
    const b = r.body.suggested_basket;
    const lines: string[] = [];
    for (const t of r.body.understood ?? []) lines.push(`understood "${t.raw}" -> ${t.term}${t.quantity ? ` (${t.quantity.value} ${t.quantity.unit})` : ''}`);
    lines.push(`${(r.body.offers ?? []).length} offers from the network.`);
    if (b) {
      const id = `b${++this.seq}`;
      this.baskets.set(id, { bpp_id: b.bpp_id, provider_id: b.provider_id, provider_name: b.provider_name, items: b.items.map((i: { id: string; count: number }) => ({ id: i.id, count: i.count })) });
      lines.push(`Suggested basket ${id} from ${b.provider_name}:`);
      for (const it of b.items) lines.push(`- ${it.count} x ${it.name}  Rs ${it.line_total}  (for "${it.for}", ${it.fit})`);
      if (b.why) lines.push(`Why this seller: ${typeof b.why === 'string' ? b.why : JSON.stringify(b.why)}`);
    } else lines.push('No single seller covers this request.');
    for (const m of b?.missing ?? []) lines.push(`missing: ${m.raw}: ${m.reason}`);
    if (b) lines.push(`To order, call place_order with basket_id "${`b${this.seq}`}". The person will be asked to approve.`);
    return text(lines.join('\n'));
  }

  private async order(basketId: string, ctx: ToolContext): Promise<ToolResult> {
    const basket = this.baskets.get(basketId);
    if (!basket) return text(`Unknown basket_id "${basketId}". Run search_groceries first.`, true);
    if (!ctx.canElicit) {
      return text('This client cannot ask the person for approval (no MCP elicitation support), so nothing was ordered. Haat never orders without the person approving on their own screen.', true);
    }
    const company = await this.co();
    const cart = { bpp_id: basket.bpp_id, provider_id: basket.provider_id, items: basket.items, delivery: this.delivery };
    let declined = false;
    const placed = await this.agent.callWithApproval(company, this.sid, 'POST', '/api/v1/orders', cart, async (op: Operation) => {
      const res = await ctx.elicit(`Approve this order?\n\n${op.summary}`, {
        type: 'object',
        properties: { approve: { type: 'boolean', title: 'Place this order', description: 'Yes orders exactly what is shown above.' } },
        required: ['approve'],
      });
      const yes = res.action === 'accept' && res.content?.approve === true;
      declined = !yes;
      return yes;
    });
    if (declined || placed.approved === false) return text('The person did not approve. Nothing was ordered.');
    if (placed.status === 503) return text('The seller has not confirmed yet and the outcome is unknown. Do NOT order again; check order status later.', true);
    if (placed.status !== 201) return text(`Order was not placed (HTTP ${placed.status}): ${JSON.stringify(placed.body)}`, true);
    const o = placed.body;
    return text(`Order placed: ${o.order_id} with ${o.seller.name}, total Rs ${o.total.amount}, payment ${o.payment.type}.`);
  }

  private async status(orderId: string): Promise<ToolResult> {
    if (!orderId) return text('Give an order_id.', true);
    const company = await this.co();
    const r = await this.agent.call(company, this.sid, 'GET', `/api/v1/orders/${encodeURIComponent(orderId)}`);
    if (r.status !== 200) return text(`Could not read order (HTTP ${r.status}).`, true);
    return text(`Order ${orderId}: ${r.body.fulfillment_state}`);
  }

  server(): McpServer {
    return new McpServer(
      { name: 'haat', version: process.env.npm_package_version ?? '0.1.0' },
      this.tools(),
      'Haat lets you shop for groceries in Indian languages on a local mock ONDC network. Search first, then place_order. The person approves every order themselves; you never approve.',
    );
  }
}
