/**
 * Production entry point. Everything comes from environment variables (see .env.example).
 *
 *   HAAT_NETWORK=mock   the built-in local network (default; for trying it out)
 *   HAAT_NETWORK=ondc   a real ONDC registry and gateway (pre-production first; see docs/going-live.md)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startGateway } from './gateway.ts';
import { ONDC_REGISTRY } from './ondc/onboarding.ts';

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing environment variable ${k}`);
  return v;
};

const network = process.env.HAAT_NETWORK ?? 'mock';
const port = Number(process.env.HAAT_PORT ?? 8080);
const host = process.env.HAAT_HOST ?? '127.0.0.1';
const tls = process.env.HAAT_TLS_KEY ? { key: readFileSync(env('HAAT_TLS_KEY')), cert: readFileSync(env('HAAT_TLS_CERT')) } : undefined;

if (network === 'mock') {
  const { startNetwork } = await import('../mock-network/network.ts');
  // HAAT_PUBLIC_URL must be the address clients use: poppy.json's domain has to match it (spec 3.1).
  const net = await startNetwork({ gatewayPort: port, gatewayPublicUrl: process.env.HAAT_PUBLIC_URL, stageSec: 30, extraGatewayConfig: { dbPath: process.env.HAAT_DB, host } });
  console.log(`Haat (mock network) on ${net.gatewayUrl}. Not connected to real ONDC.`);
} else if (network === 'ondc') {
  const envName = env('HAAT_ONDC_ENV', 'preprod') as keyof typeof ONDC_REGISTRY;
  const reg = ONDC_REGISTRY[envName];
  if (!reg) throw new Error('HAAT_ONDC_ENV must be preprod or prod');
  const publicUrl = env('HAAT_PUBLIC_URL');
  if (!publicUrl.startsWith('https://')) throw new Error('HAAT_PUBLIC_URL must be https in ONDC mode');
  const g = await startGateway(
    {
      publicUrl,
      devInsecure: false,
      organizationName: env('HAAT_ORG_NAME'),
      bap: {
        subscriberId: env('ONDC_SUBSCRIBER_ID'),
        uniqueKeyId: env('ONDC_UNIQUE_KEY_ID'),
        privateKeyB64: env('ONDC_SIGNING_PRIVATE_KEY'),
        publicKeyB64: env('ONDC_SIGNING_PUBLIC_KEY'),
      },
      registryUrl: reg.lookupUrl,
      becknGatewayUrl: env('ONDC_GATEWAY_URL'),
      city: env('HAAT_CITY', 'std:0542'),
      packsDir: join(import.meta.dirname, '..', 'packs'),
      dbPath: env('HAAT_DB'),
      // A real OTP provider is required outside dev mode; Haat refuses to start without one.
      signIn: { enabled: process.env.HAAT_SIGN_IN === 'on' },
      ondc: {
        registryLookupUrl: reg.lookupUrl,
        ...(process.env.ONDC_REQUEST_ID
          ? {
              onboarding: {
                requestId: env('ONDC_REQUEST_ID'),
                encryptionPrivateKey: env('ONDC_ENCRYPTION_PRIVATE_KEY'),
                registryEncryptionPublicKey: reg.encryptionPublicKey,
                callbackPath: env('ONDC_CALLBACK_PATH', '/ondc'),
              },
            }
          : {}),
      },
      host,
    },
    port,
    host,
    tls,
  );
  console.log(`Haat (ONDC ${envName}) on ${g.url}, public ${publicUrl}`);
} else {
  throw new Error('HAAT_NETWORK must be mock or ondc');
}
