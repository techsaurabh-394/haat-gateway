/**
 * Beckn / ONDC request signing.
 *
 * Every Beckn API call carries an `Authorization` header signed with the sender's Ed25519 key:
 *
 *   Signature keyId="{subscriber_id}|{unique_key_id}|ed25519",algorithm="ed25519",
 *     created="{unix}",expires="{unix}",headers="(created) (expires) digest",signature="{base64}"
 *
 * The signed string is:
 *   (created): {created}\n(expires): {expires}\ndigest: BLAKE-512={base64(blake2b512(body))}
 *
 * Verifying it needs the sender's public key, which comes from the network registry lookup.
 * This follows the ONDC "signing and verification" developer guide; check it against the
 * current ONDC docs before connecting to a real network (docs/limitations.md).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type SigningKey = { subscriberId: string; uniqueKeyId: string; privateKey: KeyObject; publicKeyB64: string };

export function generateEd25519(): { privateKey: KeyObject; publicKeyB64: string; privateKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    privateKey,
    publicKeyB64: spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64'),
    privateKeyB64: pkcs8.subarray(ED25519_PKCS8_PREFIX.length).toString('base64'),
  };
}

/** ONDC registries publish raw 32-byte Ed25519 public keys, base64-encoded. */
export function ed25519PublicKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function ed25519PrivateKeyFromB64(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw; // accept seed or seed||public
  if (seed.length !== 32) throw new Error('Ed25519 private key must be a 32-byte seed');
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function blake512B64(body: Buffer | string): string {
  return createHash('blake2b512').update(body).digest('base64');
}

export function signingString(created: number, expires: number, body: Buffer | string): string {
  return `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${blake512B64(body)}`;
}

export function createAuthorizationHeader(key: SigningKey, body: Buffer | string, nowSec = Math.floor(Date.now() / 1000), ttlSec = 300): string {
  const created = nowSec;
  const expires = nowSec + ttlSec;
  const sig = sign(null, Buffer.from(signingString(created, expires, body)), key.privateKey).toString('base64');
  return `Signature keyId="${key.subscriberId}|${key.uniqueKeyId}|ed25519",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${sig}"`;
}

export type ParsedAuthorization = {
  subscriberId: string;
  uniqueKeyId: string;
  algorithm: string;
  created: number;
  expires: number;
  headers: string;
  signature: string;
};

export function parseAuthorizationHeader(h: string | undefined): ParsedAuthorization | null {
  if (!h || !h.startsWith('Signature ')) return null;
  const fields: Record<string, string> = {};
  for (const m of h.slice('Signature '.length).matchAll(/([a-zA-Z]+)="([^"]*)"/g)) fields[m[1]!] = m[2]!;
  const keyParts = (fields.keyId ?? '').split('|');
  if (keyParts.length !== 3 || keyParts[2] !== 'ed25519') return null;
  const created = Number(fields.created);
  const expires = Number(fields.expires);
  if (!Number.isInteger(created) || !Number.isInteger(expires) || !fields.signature) return null;
  return {
    subscriberId: keyParts[0]!,
    uniqueKeyId: keyParts[1]!,
    algorithm: fields.algorithm ?? '',
    created,
    expires,
    headers: fields.headers ?? '',
    signature: fields.signature,
  };
}

export type KeyLookup = (subscriberId: string, uniqueKeyId: string) => Promise<string | null>;

export type VerifyResult = { ok: true; subscriberId: string } | { ok: false; reason: string };

export async function verifyAuthorizationHeader(
  header: string | undefined,
  body: Buffer | string,
  lookup: KeyLookup,
  nowSec = Math.floor(Date.now() / 1000),
  skewSec = 5,
): Promise<VerifyResult> {
  const p = parseAuthorizationHeader(header);
  if (!p) return { ok: false, reason: 'missing or malformed Authorization header' };
  if (p.algorithm !== 'ed25519') return { ok: false, reason: 'algorithm must be ed25519' };
  if (p.headers !== '(created) (expires) digest') return { ok: false, reason: 'unexpected signed headers list' };
  if (p.created > nowSec + skewSec) return { ok: false, reason: 'signature created in the future' };
  if (p.expires < nowSec - skewSec) return { ok: false, reason: 'signature expired' };
  const pubB64 = await lookup(p.subscriberId, p.uniqueKeyId);
  if (!pubB64) return { ok: false, reason: `no registry key for ${p.subscriberId}|${p.uniqueKeyId}` };
  let ok: boolean;
  try {
    ok = verify(null, Buffer.from(signingString(p.created, p.expires, body)), ed25519PublicKeyFromB64(pubB64), Buffer.from(p.signature, 'base64'));
  } catch {
    ok = false;
  }
  return ok ? { ok: true, subscriberId: p.subscriberId } : { ok: false, reason: 'signature does not verify' };
}
