/**
 * Serves the gateway (https://haat.localhost) and the validator's test agent files
 * (https://agent.localhost:8443) over HTTPS with a local CA. Used by run-official-validator.sh.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startNetwork } from '../../mock-network/network.ts';
import { Router, json, startServer } from '../../src/util/http.ts';

const dir = process.env.CONF_DIR!;
const tls = { key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')) };
const net = await startNetwork({ gatewayPort: 443, gatewayPublicUrl: 'https://haat.localhost', tls, stageSec: 60 });

const agentDir = join(process.env.VALIDATOR_DIR!, '.poppy');
const r = new Router();
r.on('GET', '/agent.json', () => json(200, JSON.parse(readFileSync(join(agentDir, 'agent.json'), 'utf8'))));
r.on('GET', '/jwks.json', () => json(200, JSON.parse(readFileSync(join(agentDir, 'jwks.json'), 'utf8'))));
await startServer(r, 8443, '127.0.0.1', tls);
console.log(`ready ${net.gatewayUrl}`);
process.on('SIGTERM', async () => {
  await net.stop();
  process.exit(0);
});
