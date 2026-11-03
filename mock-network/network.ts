/**
 * Starts a complete local ONDC-like network plus the Haat gateway, on free localhost ports:
 *
 *   registry  <- lookups from everyone
 *   Beckn gateway (BG)  <- search fan-out
 *   3 mock sellers (Varanasi): Kashi Kirana Store, Ganga Dairy, Assi Sabzi Mandi
 *   Haat gateway  <- Personal Agents (Poppy) ; -> network (Beckn)
 *
 * Used by `npm start`, `npm run demo` and the end-to-end tests.
 */
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegistryClient, type Subscriber } from '../src/beckn/registry.ts';
import { generateEd25519, type SigningKey } from '../src/beckn/signing.ts';
import { startGateway, type GatewayConfig } from '../src/gateway.ts';
import { closeServer, type TlsOptions } from '../src/util/http.ts';
import { startRegistry } from './registry.ts';
import { startBecknGateway } from './beckn-gateway.ts';
import { loadSeller, startSeller } from './seller.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
const CITY = 'std:0542'; // Varanasi
const DOMAIN = 'ONDC:RET10';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function key(subscriberId: string): SigningKey & { privateKeyB64: string } {
  const k = generateEd25519();
  return { subscriberId, uniqueKeyId: 'k1', privateKey: k.privateKey, publicKeyB64: k.publicKeyB64, privateKeyB64: k.privateKeyB64 };
}

export type NetworkOptions = {
  gatewayPort?: number;
  /** Seconds per fulfilment stage in the mock sellers. */
  stageSec?: number;
  searchWindowMs?: number;
  extraGatewayConfig?: Partial<GatewayConfig>;
  /** Serve the gateway over HTTPS at this public URL (for example https://haat.localhost). */
  gatewayPublicUrl?: string;
  tls?: TlsOptions;
};

export async function startNetwork(opts: NetworkOptions = {}) {
  const [registryPort, bgPort, gatewayPort, ...sellerPorts] = await Promise.all([
    freePort(), freePort(), opts.gatewayPort ? Promise.resolve(opts.gatewayPort) : freePort(), freePort(), freePort(), freePort(),
  ]);
  const registryUrl = `http://127.0.0.1:${registryPort}`;
  const bgUrl = `http://127.0.0.1:${bgPort}`;
  const gatewayUrl = opts.gatewayPublicUrl ?? `http://127.0.0.1:${gatewayPort}`;

  const bapKey = key('haat.bap.example');
  const bgKey = key('gateway.bg.example');
  const sellerFiles = ['kashi-kirana.json', 'ganga-dairy.json', 'assi-sabzi.json'].map((f) => loadSeller(join(here, 'sellers', f)));
  const sellerKeys = sellerFiles.map((f) => key(f.subscriber_id));

  const subscribers: Subscriber[] = [
    { subscriber_id: bapKey.subscriberId, ukId: 'k1', type: 'BAP', subscriber_url: `${gatewayUrl}/beckn`, signing_public_key: bapKey.publicKeyB64, domain: DOMAIN, city: '*', status: 'SUBSCRIBED' },
    { subscriber_id: bgKey.subscriberId, ukId: 'k1', type: 'BG', subscriber_url: bgUrl, signing_public_key: bgKey.publicKeyB64, domain: DOMAIN, city: '*', status: 'SUBSCRIBED' },
    ...sellerFiles.map((f, i) => ({
      subscriber_id: f.subscriber_id, ukId: 'k1', type: 'BPP' as const, subscriber_url: `http://127.0.0.1:${sellerPorts[i]}`,
      signing_public_key: sellerKeys[i]!.publicKeyB64, domain: DOMAIN, city: CITY, status: 'SUBSCRIBED',
    })),
  ];

  const registry = await startRegistry(subscribers, registryPort!);
  const regClient = () => new RegistryClient(registryUrl, 2000);
  const bg = await startBecknGateway(bgKey, regClient(), bgPort!);
  const sellers = await Promise.all(sellerFiles.map((f, i) =>
    startSeller({ key: sellerKeys[i]!, file: f, registry: regClient(), url: `http://127.0.0.1:${sellerPorts[i]}`, stageSec: opts.stageSec ?? 20 }, sellerPorts[i]!),
  ));
  const gwConfig = {
    publicUrl: gatewayUrl,
    devInsecure: true,
    organizationName: 'Haat (local dev)',
    bap: { subscriberId: bapKey.subscriberId, uniqueKeyId: 'k1', privateKeyB64: bapKey.privateKeyB64, publicKeyB64: bapKey.publicKeyB64 },
    registryUrl,
    becknGatewayUrl: bgUrl,
    city: CITY,
    packsDir: join(ROOT, 'packs'),
    searchWindowMs: opts.searchWindowMs ?? 600,
    ...opts.extraGatewayConfig,
  };
  let gw = await startGateway(gwConfig, gatewayPort!, '127.0.0.1', opts.tls);

  return {
    gatewayUrl,
    registryUrl,
    bgUrl,
    sellers: sellerFiles.map((f, i) => ({ name: f.provider.name, id: f.subscriber_id, url: `http://127.0.0.1:${sellerPorts[i]}` })),
    get gateway() {
      return gw.gateway;
    },
    /** Simulates a crash and restart of the gateway only (the network keeps running). */
    async restartGateway(over: Partial<GatewayConfig> = {}) {
      await gw.stop();
      if (!gwConfig.kv) gw.gateway.kv.close();
      gw = await startGateway({ ...gwConfig, ...over }, gatewayPort!, '127.0.0.1', opts.tls);
    },
    async stop() {
      await Promise.all([gw.stop(), closeServer(registry.server), closeServer(bg.server), ...sellers.map((s) => closeServer(s.server))]);
      if (!gwConfig.kv) gw.gateway.kv.close();
    },
  };
}
