/**
 * A tiny Model Context Protocol server over newline-delimited JSON-RPC (stdio transport).
 * No dependencies. It supports what Haat needs: initialize, ping, tools/list, tools/call, and
 * server-to-client `elicitation/create` requests (how the person approves an order).
 */
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

export const MCP_VERSION = '2025-06-18';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hints for clients: only the order tool changes the world. */
  annotations?: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};

export type ElicitResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

export type ToolContext = {
  /** True when the connected client declared the `elicitation` capability. */
  canElicit: boolean;
  /** Asks the person (not the model) a question through the client's own UI. */
  elicit(message: string, schema: Record<string, unknown>): Promise<ElicitResult>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC messages are untyped input
type Json = Record<string, any>;

export class McpServer {
  private clientCaps: Json = {};
  private nextId = 1;
  private pending = new Map<number, (m: Json) => void>();
  private inflight = new Set<Promise<void>>();

  private info: { name: string; version: string };
  private tools: Tool[];
  private instructions?: string;

  constructor(info: { name: string; version: string }, tools: Tool[], instructions?: string) {
    this.info = info;
    this.tools = tools;
    this.instructions = instructions;
  }

  /** Reads messages from `input` until it closes; writes replies to `output`. */
  async serve(input: Readable, output: Writable): Promise<void> {
    const send = (m: Json) => output.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    const rl = createInterface({ input });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // A reply to something we asked the client (elicitation).
      if (msg.id !== undefined && msg.method === undefined) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
        continue;
      }
      const p = this.handle(msg, send).catch(() => {});
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    }
    await Promise.all(this.inflight);
  }

  private async handle(msg: Json, send: (m: Json) => void): Promise<void> {
    const reply = (result: unknown) => msg.id !== undefined && send({ id: msg.id, result });
    const fail = (code: number, message: string) => msg.id !== undefined && send({ id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        this.clientCaps = msg.params?.capabilities ?? {};
        reply({
          protocolVersion: MCP_VERSION,
          capabilities: { tools: {} },
          serverInfo: this.info,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        });
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: this.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
        return;
      case 'tools/call': {
        const tool = this.tools.find((t) => t.name === msg.params?.name);
        if (!tool) return void fail(-32602, `Unknown tool: ${msg.params?.name}`);
        const ctx: ToolContext = {
          canElicit: Boolean(this.clientCaps.elicitation),
          elicit: (message, requestedSchema) => this.request(send, 'elicitation/create', { message, requestedSchema }) as Promise<ElicitResult>,
        };
        try {
          reply(await tool.run(msg.params?.arguments ?? {}, ctx));
        } catch (e) {
          reply({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true } satisfies ToolResult);
        }
        return;
      }
      default:
        if (msg.method?.startsWith('notifications/')) return; // nothing to do
        fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  private request(send: (m: Json) => void, method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(m.error.message ?? 'client error')) : resolve(m.result)));
      send({ id, method, params });
    });
  }
}
