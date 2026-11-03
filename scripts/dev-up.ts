/**
 * npm start  — runs the gateway plus a local mock ONDC network until you press Ctrl+C.
 * HAAT_PORT=8080 by default. Point your own Personal Agent (or the reference one) at it.
 */
import { startNetwork } from '../mock-network/network.ts';

const port = Number(process.env.HAAT_PORT ?? 8080);
const net = await startNetwork({ gatewayPort: port, stageSec: Number(process.env.HAAT_STAGE_SEC ?? 30) });

console.log(`
Haat gateway (local dev) is running.

  Discovery     ${net.gatewayUrl}/.well-known/poppy.json
  OpenAPI       ${net.gatewayUrl}/openapi.json
  Health        ${net.gatewayUrl}/health
  Registry      ${net.registryUrl}/subscribers
  Sellers       ${net.sellers.map((s) => `${s.name} (${s.id})`).join(', ')}

Every API call needs a Poppy-Session header, so use a Personal Agent client.
The quickest one is in agent/personal-agent.ts; see docs/quickstart.md.
Press Ctrl+C to stop.
`);

const stop = async () => {
  await net.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
