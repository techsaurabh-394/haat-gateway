#!/usr/bin/env node
/**
 * npx-free entry: `node src/mcp/main.ts` speaks MCP on stdin/stdout.
 *
 *   HAAT_URL=https://...   use an existing Haat gateway (default: start the local mock network)
 *   HAAT_DELIVERY='{...}'  delivery JSON (name, phone, address, gps); default is a demo address
 *
 * stdout carries only protocol messages; everything else goes to stderr.
 */
import { startNetwork } from '../../mock-network/network.ts';
import { PersonalAgent } from '../../agent/personal-agent.ts';
import { HaatMcp } from './server.ts';

const agent = await new PersonalAgent({ name: 'Haat MCP' }).start();
let net: Awaited<ReturnType<typeof startNetwork>> | undefined;
let gatewayUrl = process.env.HAAT_URL;
if (!gatewayUrl) {
  net = await startNetwork({ stageSec: 10 });
  gatewayUrl = net.gatewayUrl;
  console.error(`haat-mcp: local mock network at ${gatewayUrl} (not connected to real ONDC)`);
}
let delivery: Record<string, unknown> | undefined;
if (process.env.HAAT_DELIVERY) delivery = JSON.parse(process.env.HAAT_DELIVERY);

const mcp = new HaatMcp({ agent, gatewayUrl, delivery });
await mcp.server().serve(process.stdin, process.stdout);
await agent.stop();
await net?.stop();
