import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const MAIN = join(import.meta.dirname, '..', 'src', 'mcp', 'main.ts');

/** A minimal MCP client: the "person" is the `onElicit` callback. */
function client(opts: { elicit: boolean; onElicit?: (message: string) => { action: string; content?: unknown } }) {
  const child = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HAAT_LOG: 'silent' } });
  const pending = new Map<number, (m: any) => void>();
  const elicited: string[] = [];
  let id = 0;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const m = JSON.parse(line); // every stdout line must be valid JSON-RPC
    if (m.method === 'elicitation/create') {
      elicited.push(m.params.message);
      const a = opts.onElicit?.(m.params.message) ?? { action: 'decline' };
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: a }) + '\n');
    } else if (m.id !== undefined) pending.get(m.id)?.(m);
  });
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    });
  const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result;
  const init = () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: opts.elicit ? { elicitation: {} } : {}, clientInfo: { name: 't', version: '0' } });
  const close = () => new Promise<void>((r) => { child.on('exit', () => r()); child.stdin.end(); });
  return { rpc, call, init, close, elicited };
}

test('MCP: initialize, list tools, search in Hinglish', async () => {
  const c = client({ elicit: true });
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, 'haat');
  const tools = (await c.rpc('tools/list')).result.tools.map((t: any) => t.name);
  assert.deepEqual(tools, ['search_groceries', 'place_order', 'order_status']);
  const s = await c.call('search_groceries', { query: 'do kilo aata aur ek litre doodh' });
  assert.ok(!s.isError, s.content[0].text);
  assert.match(s.content[0].text, /Suggested basket b1/);
  await c.close();
});

test('MCP: the person approves, one order is placed, status works', async () => {
  const c = client({ elicit: true, onElicit: () => ({ action: 'accept', content: { approve: true } }) });
  await c.init();
  await c.call('search_groceries', { query: '2 kilo aata' });
  const o = await c.call('place_order', { basket_id: 'b1' });
  assert.match(o.content[0].text, /Order placed: \S+/, o.content[0].text);
  assert.equal(c.elicited.length, 1);
  assert.match(c.elicited[0]!, /Approve this order/);
  const id = /Order placed: (\S+)/.exec(o.content[0].text)![1]!;
  const st = await c.call('order_status', { order_id: id });
  assert.match(st.content[0].text, new RegExp(`Order ${id}:`));
  await c.close();
});

test('MCP: declining orders nothing', async () => {
  const c = client({ elicit: true, onElicit: () => ({ action: 'decline' }) });
  await c.init();
  await c.call('search_groceries', { query: '2 kilo aata' });
  const o = await c.call('place_order', { basket_id: 'b1' });
  assert.match(o.content[0].text, /Nothing was ordered/);
  assert.equal(c.elicited.length, 1);
  await c.close();
});

test('MCP: a client that cannot elicit can never order', async () => {
  const c = client({ elicit: false });
  await c.init();
  await c.call('search_groceries', { query: '2 kilo aata' });
  const o = await c.call('place_order', { basket_id: 'b1' });
  assert.equal(o.isError, true);
  assert.match(o.content[0].text, /nothing was ordered/);
  assert.equal(c.elicited.length, 0);
  await c.close();
});

test('MCP: unknown basket, unknown tool, unknown method', async () => {
  const c = client({ elicit: true });
  await c.init();
  const o = await c.call('place_order', { basket_id: 'b99' });
  assert.equal(o.isError, true);
  const bad = await c.rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(bad.error.code, -32602);
  const m = await c.rpc('resources/list');
  assert.equal(m.error.code, -32601);
  await c.close();
});
