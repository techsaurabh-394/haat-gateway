/**
 * Where approval messages are sent. The gateway only needs `send`; the real WhatsApp Business
 * (Cloud API) provider and the mock one used in tests both implement it.
 */
export type ApprovalMessage = {
  /** Recipient in international format without "+", for example "919876543210". */
  to: string;
  /** The exact approval summary the person is asked to approve. */
  summary: string;
  /** Single-use approval link. Treat as a secret. */
  link: string;
  expiresAt: string;
};

export interface MessageProvider {
  send(m: ApprovalMessage): Promise<{ id: string }>;
}

/** Keeps messages in memory. For tests and local development: nothing leaves the machine. */
export class MockWhatsAppProvider implements MessageProvider {
  outbox: ApprovalMessage[] = [];
  /** Test hook: make the next send fail. */
  failNext = false;
  async send(m: ApprovalMessage): Promise<{ id: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mock provider: send failed');
    }
    this.outbox.push(m);
    return { id: `mock-${this.outbox.length}` };
  }
}

/** Prints the message instead of sending it. Local development only: nothing leaves the machine. */
export class ConsoleWhatsAppProvider implements MessageProvider {
  async send(m: ApprovalMessage): Promise<{ id: string }> {
    console.log(`[whatsapp dev] to ${m.to}\n${m.summary}\nApprove: ${m.link}`);
    return { id: 'console' };
  }
}

export type CloudApiOptions = {
  accessToken: string;
  phoneNumberId: string;
  /** Name of a message template approved by Meta with two body variables: {{1}} summary, {{2}} link. */
  template: string;
  language?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
};

/**
 * WhatsApp Business Cloud API. Messages that start a conversation must use an approved template,
 * so the summary and link are sent as the template's two body variables.
 * Not verified against the live API in this repository: it needs a Meta business account, and
 * the template must be approved first (see docs/whatsapp.md).
 */
export class WhatsAppCloudProvider implements MessageProvider {
  o: CloudApiOptions;
  constructor(o: CloudApiOptions) {
    this.o = o;
  }

  /** Template variables may not contain newlines, tabs or long runs of spaces. */
  static param(text: string): string {
    return text.replace(/[\r\n\t]+/g, ' | ').replace(/ {4,}/g, '   ').slice(0, 900);
  }

  request(m: ApprovalMessage): { url: string; init: RequestInit } {
    const url = `https://graph.facebook.com/${this.o.apiVersion ?? 'v21.0'}/${encodeURIComponent(this.o.phoneNumberId)}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: m.to,
      type: 'template',
      template: {
        name: this.o.template,
        language: { code: this.o.language ?? 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: WhatsAppCloudProvider.param(m.summary) }, { type: 'text', text: m.link }] }],
      },
    };
    return { url, init: { method: 'POST', headers: { authorization: `Bearer ${this.o.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) } };
  }

  async send(m: ApprovalMessage): Promise<{ id: string }> {
    const { url, init } = this.request(m);
    const res = await (this.o.fetchImpl ?? fetch)(url, init);
    const data = (await res.json().catch(() => null)) as { messages?: Array<{ id?: string }>; error?: { message?: string } } | null;
    const id = data?.messages?.[0]?.id;
    if (!res.ok || !id) throw new Error(`WhatsApp send failed (${res.status}): ${data?.error?.message ?? 'no message id'}`);
    return { id };
  }
}

/** "9876543210" or "+91 98765 43210" -> "919876543210". Returns undefined for anything else. */
export function whatsappNumber(phone: string): string | undefined {
  const d = phone.replace(/[^\d]/g, '');
  if (/^[6-9]\d{9}$/.test(d)) return '91' + d;
  if (/^91[6-9]\d{9}$/.test(d)) return d;
  return undefined;
}
