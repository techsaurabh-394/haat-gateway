import { createHash, randomBytes } from 'node:crypto';

/** base64url without padding (RFC 4648 section 5). */
export function b64u(data: Buffer | Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

export function fromB64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Random, unguessable ID made only of URL-safe base64 characters (Poppy spec 8.2). */
export function randomId(prefix = '', bytes = 12): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
/** Poppy IDs: 1-256 chars from the URL-safe base64 alphabet. */
export function isPoppyId(s: unknown): s is string {
  return typeof s === 'string' && ID_RE.test(s);
}

/** Deterministic JSON (sorted keys) so hashes of equal objects are equal. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
}
