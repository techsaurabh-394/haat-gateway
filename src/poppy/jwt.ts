import { constants, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { b64u, fromB64u, sha256 } from '../util/b64.ts';

export type EcJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid?: string; alg?: string; use?: string };
export type RsaJwk = { kty: 'RSA'; n: string; e: string; kid?: string; alg?: string; use?: string };
export type PublicJwk = EcJwk | RsaJwk;

export type DecodedJwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
};

const MAX_JWT = 8192;

/** RFC 7638 JWK thumbprint for an EC key (required members in lexicographic order). */
export function jwkThumbprint(jwk: { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown; n?: unknown; e?: unknown }): string {
  if (jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string') {
    return b64u(sha256(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })));
  }
  if (jwk.kty !== 'EC' || typeof jwk.crv !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('thumbprint: only EC and RSA keys are supported');
  }
  return b64u(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

/** Public RSA key of at least 2048 bits, with no private members. */
export function isPublicRsaJwk(j: unknown): j is RsaJwk {
  if (!j || typeof j !== 'object') return false;
  const k = j as Record<string, unknown>;
  if (['d', 'p', 'q', 'dp', 'dq', 'qi'].some((m) => m in k)) return false;
  return k.kty === 'RSA' && typeof k.n === 'string' && typeof k.e === 'string' && fromB64u(k.n).length >= 256;
}

export function generateRsa(): { privateKey: KeyObject; publicJwk: RsaJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { privateKey, publicJwk: { kty: 'RSA', n: j.n!, e: j.e! } };
}

/** RSASSA-PSS with SHA-384 and a 48-byte salt (RFC 7518 section 3.5). */
export function signPs384(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const h = b64u(JSON.stringify({ ...header, alg: 'PS384' }));
  const p = b64u(JSON.stringify(payload));
  const sig = sign('sha384', Buffer.from(`${h}.${p}`), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 });
  return `${h}.${p}.${b64u(sig)}`;
}

export function verifyPs384(decoded: DecodedJwt, jwk: RsaJwk): boolean {
  if (decoded.header.alg !== 'PS384') return false;
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    return verify('sha384', decoded.signingInput, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, decoded.signature);
  } catch {
    return false;
  }
}

/** Verifies a JWS signed with ES256 or PS384, choosing by `alg` and the key type. */
export function verifyJws(decoded: DecodedJwt, jwk: PublicJwk): boolean {
  if (decoded.header.alg === 'ES256' && jwk.kty === 'EC') return verifyEs256(decoded, jwk);
  if (decoded.header.alg === 'PS384' && jwk.kty === 'RSA') return verifyPs384(decoded, jwk);
  return false;
}

export function isPublicP256Jwk(j: unknown): j is EcJwk {
  if (!j || typeof j !== 'object') return false;
  const k = j as Record<string, unknown>;
  if ('d' in k) return false; // private members are forbidden in cnf.jwk / JWKS
  if (k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string') return false;
  return fromB64u(k.x).length === 32 && fromB64u(k.y).length === 32;
}

export function generateP256(): { privateKey: KeyObject; publicJwk: EcJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! } };
}

export function signEs256(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  const h = b64u(JSON.stringify({ ...header, alg: 'ES256' }));
  const p = b64u(JSON.stringify(payload));
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u(sig)}`;
}

function parseObject(part: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(fromB64u(part).toString('utf8'));
  } catch {
    throw new Error(`${what} is not valid base64url JSON`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} is not a JSON object`);
  return v as Record<string, unknown>;
}

/** Splits a compact JWS. Does NOT verify anything. */
export function decodeJwt(token: string): DecodedJwt {
  if (typeof token !== 'string' || token.length > MAX_JWT) throw new Error('token missing or too large');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error('not a compact JWS');
  return {
    header: parseObject(parts[0]!, 'header'),
    payload: parseObject(parts[1]!, 'payload'),
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature: fromB64u(parts[2]!),
  };
}

/** Verifies an ES256 signature over a decoded JWS with a public P-256 JWK. */
export function verifyEs256(decoded: DecodedJwt, jwk: EcJwk): boolean {
  if (decoded.header.alg !== 'ES256' || decoded.signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    return verify('sha256', decoded.signingInput, { key, dsaEncoding: 'ieee-p1363' }, decoded.signature);
  } catch {
    return false;
  }
}
