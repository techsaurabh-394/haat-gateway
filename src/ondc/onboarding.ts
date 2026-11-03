/**
 * ONDC network onboarding: what a buyer app must host and compute to subscribe to the registry.
 * Follows ONDC-Official/developer-docs "registry/Onboarding of Participants.md" and the official
 * on_subscribe utility (ONDC-Official/reference-implementations, utilities/on_subscibe-service):
 *
 *   - Ed25519 signing keys (raw 32-byte public key, base64) and X25519 encryption keys (DER, base64)
 *   - SIGNED_UNIQUE_REQ_ID: Ed25519 signature of the request_id, no hashing, base64
 *   - /ondc-site-verification.html with <meta name="ondc-site-verification" content="...">
 *   - /on_subscribe: decrypt the challenge with AES-256-ECB, key = X25519(our private, ONDC public)
 *
 * Verified here only against those references and round-trip tests, not against the live registry.
 */
import { createDecipheriv, createCipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign } from 'node:crypto';
import { ed25519PrivateKeyFromB64, generateEd25519 } from '../beckn/signing.ts';

/** Registry encryption public keys published in ONDC's onboarding document (checked 1 Nov 2026). */
export const ONDC_REGISTRY = {
  preprod: {
    subscribeUrl: 'https://preprod.registry.ondc.org/ondc/subscribe',
    lookupUrl: 'https://preprod.registry.ondc.org/v2.0/lookup',
    encryptionPublicKey: 'MCowBQYDK2VuAyEARa/WcMCzNQp4DWjvTI4DK7vHL6EdaHqN4GjFIu9wxxM=',
  },
  prod: {
    subscribeUrl: 'https://prod.registry.ondc.org/subscribe',
    lookupUrl: 'https://prod.registry.ondc.org/v2.0/lookup',
    encryptionPublicKey: 'MCowBQYDK2VuAyEAwASk2D4O3p/tuD8f9sNQAQlwOU2w3DAumcOK9qHCFwI=',
  },
} as const;

export type OndcKeys = {
  signingPublicKey: string; // raw 32 bytes, base64
  signingPrivateKey: string; // 32-byte seed, base64
  encryptionPublicKey: string; // SPKI DER, base64 (starts with MCowBQYDK2VuAyEA)
  encryptionPrivateKey: string; // PKCS#8 DER, base64
};

export function generateOndcKeys(): OndcKeys {
  const s = generateEd25519();
  const e = generateKeyPairSync('x25519');
  return {
    signingPublicKey: s.publicKeyB64,
    signingPrivateKey: s.privateKeyB64,
    encryptionPublicKey: e.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    encryptionPrivateKey: e.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** SIGNED_UNIQUE_REQ_ID: Ed25519 over the plain request_id (no hashing), base64. */
export function signRequestId(requestId: string, signingPrivateKeyB64: string): string {
  return sign(null, Buffer.from(requestId, 'utf8'), ed25519PrivateKeyFromB64(signingPrivateKeyB64)).toString('base64');
}

export function siteVerificationHtml(signedRequestId: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(signedRequestId)) throw new Error('signed request id must be base64');
  return `<html>\n  <head>\n    <meta name="ondc-site-verification" content="${signedRequestId}" />\n  </head>\n  <body>ONDC Site Verification Page</body>\n</html>\n`;
}

function sharedKey(ourPrivateDerB64: string, theirPublicDerB64: string): Buffer {
  return diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.from(ourPrivateDerB64, 'base64'), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.from(theirPublicDerB64, 'base64'), format: 'der', type: 'spki' }),
  });
}

/** Decrypts the registry's on_subscribe challenge (AES-256-ECB, PKCS#7 padding). */
export function decryptChallenge(challengeB64: string, ourEncryptionPrivateKey: string, registryEncryptionPublicKey: string): string {
  const d = createDecipheriv('aes-256-ecb', sharedKey(ourEncryptionPrivateKey, registryEncryptionPublicKey), null);
  return Buffer.concat([d.update(Buffer.from(challengeB64, 'base64')), d.final()]).toString('utf8');
}

/** The registry side of the challenge, for tests and local rehearsal only. */
export function encryptChallengeAsRegistry(plain: string, registryPrivateKey: string, ourEncryptionPublicKey: string): string {
  const c = createCipheriv('aes-256-ecb', sharedKey(registryPrivateKey, ourEncryptionPublicKey), null);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');
}

export type SubscribeTemplateInput = {
  subscriberId: string; // your domain, e.g. haat.example.in
  uniqueKeyId: string;
  requestId: string;
  keys: OndcKeys;
  callbackPath: string; // relative, e.g. /ondc
  subscriberPath: string; // relative path of the buyer app on the domain, e.g. /beckn
  domains: string[]; // e.g. ["ONDC:RET10"]
  cities: string[]; // e.g. ["std:0542"]
  validDays?: number;
};

/**
 * A /subscribe request body for ops_no 1 (buyer app), as a TEMPLATE. Field names follow ONDC's
 * published examples; check them against the SwaggerHub "ONDC-Registry-Onboarding" spec before
 * sending. Legal fields are placeholders you must fill in yourself.
 */
export function subscribeTemplate(i: SubscribeTemplateInput): Record<string, unknown> {
  const now = new Date();
  const until = new Date(now.getTime() + (i.validDays ?? 365) * 86400_000);
  return {
    context: { operation: { ops_no: 1 } },
    message: {
      request_id: i.requestId,
      timestamp: now.toISOString(),
      entity: {
        gst: { legal_entity_name: 'FILL_IN', business_address: 'FILL_IN', city_code: i.cities, gst_no: 'FILL_IN' },
        pan: { name_as_per_pan: 'FILL_IN', pan_no: 'FILL_IN', date_of_incorporation: 'FILL_IN (DD/MM/YYYY)' },
        name_of_authorised_signatory: 'FILL_IN',
        address_of_authorised_signatory: 'FILL_IN',
        email_id: 'FILL_IN',
        mobile_no: 'FILL_IN',
        country: 'IND',
        subscriber_id: i.subscriberId,
        unique_key_id: i.uniqueKeyId,
        callback_url: i.callbackPath,
        key_pair: {
          signing_public_key: i.keys.signingPublicKey,
          encryption_public_key: i.keys.encryptionPublicKey,
          valid_from: now.toISOString(),
          valid_until: until.toISOString(),
        },
      },
      network_participant: i.domains.map((domain) => ({
        subscriber_url: i.subscriberPath,
        domain,
        type: 'buyerApp',
        msn: false,
        city_code: i.cities,
      })),
    },
  };
}
