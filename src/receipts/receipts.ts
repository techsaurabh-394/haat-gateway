/**
 * Signed approval receipts. For every approved operation Haat can produce a receipt: the exact
 * terms the person approved (summary, terms, revision), when, and through which channel, signed
 * with Haat's Ed25519 receipt key. In a dispute, anyone with the public key can check that Haat
 * issued exactly these terms and that nothing was changed afterwards.
 *
 * What a receipt proves: Haat recorded this approval of these terms at this time.
 * What it does not prove: that the seller delivered, or who the person is.
 *
 * Privacy: the approval summary names the delivery address, so the receipt does NOT copy it. It
 * carries SHA-256 hashes of the exact summary and exact terms the person was shown, plus the
 * commercial facts (seller, lines, total, payment) without `deliver_to`. The owner keeps the full
 * text; in a dispute they reveal it and anyone can check it against the hashes
 * (verifyApprovedText). No phone, name, address or account key is inside the receipt. The signing key is Haat's own, separate from
 * the Beckn signing key. Set HAAT_RECEIPT_KEY to keep the same key across deployments; without it
 * the key is created once and kept in the store. Key rotation is not built yet: /.well-known/
 * haat-receipt-keys.json lists only the current key.
 */
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { b64u, sha256, stableJson } from '../util/b64.ts';
import { ed25519PrivateKeyFromB64, ed25519PublicKeyFromB64, generateEd25519 } from '../beckn/signing.ts';
import type { KV } from '../store/kv.ts';
import type { ApprovalFacts } from '../poppy/operations.ts';

const DOMAIN_TAG = 'haat-approval-receipt-v1\n';
const NS = 'receipt_key';

export type ReceiptPayload = {
  v: 1;
  type: 'haat.approval-receipt';
  issuer: string;
  operation_id: string;
  /** What kind of action: order or cancel. Never contains ids of the person. */
  action: string;
  revision: string;
  approved_at: string;
  channel: 'header' | 'link';
  /** SHA-256 (base64url) of the exact summary text the person was shown. */
  summary_sha256: string;
  /** SHA-256 (base64url) of the stable JSON of the exact terms, delivery details included. */
  terms_sha256: string;
  /** The commercial terms without delivery details (seller, lines, total, payment). */
  terms: Record<string, unknown> | null;
  /** When the approved revision stopped being approvable. */
  expires_at: string;
  /** Outcome known to Haat when the receipt was issued. */
  state: 'pending' | 'performing' | 'performed';
};

export type SignedReceipt = { payload: ReceiptPayload; kid: string; alg: 'Ed25519'; signature: string };

export type ReceiptKey = { kid: string; privateKey: KeyObject; publicKeyB64: string };

export const keyId = (publicKeyB64: string): string => b64u(sha256(publicKeyB64)).slice(0, 16);

/** The signing key: from config when given, else created once and kept in the store. */
export function loadReceiptKey(kv: KV, privateKeyB64?: string): ReceiptKey {
  if (privateKeyB64) {
    const privateKey = ed25519PrivateKeyFromB64(privateKeyB64);
    const publicKeyB64 = publicOf(privateKey);
    return { kid: keyId(publicKeyB64), privateKey, publicKeyB64 };
  }
  const stored = kv.get<{ privateKeyB64: string }>(NS, 'current');
  if (stored) {
    const privateKey = ed25519PrivateKeyFromB64(stored.privateKeyB64);
    const publicKeyB64 = publicOf(privateKey);
    return { kid: keyId(publicKeyB64), privateKey, publicKeyB64 };
  }
  const k = generateEd25519();
  kv.set(NS, 'current', { privateKeyB64: k.privateKeyB64 });
  return { kid: keyId(k.publicKeyB64), privateKey: k.privateKey, publicKeyB64: k.publicKeyB64 };
}

function publicOf(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

const signingInput = (p: ReceiptPayload) => Buffer.from(DOMAIN_TAG + stableJson(p));

const hash = (v: string) => b64u(sha256(v));

/** Terms safe to put in a receipt: everything except where the order goes. */
function publicTerms(terms: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!terms) return null;
  const { deliver_to: _removed, ...rest } = terms;
  return rest;
}

export function buildPayload(a: { issuer: string; operationId: string; actionKey: string; state: ReceiptPayload['state']; approval: ApprovalFacts }): ReceiptPayload {
  return {
    v: 1,
    type: 'haat.approval-receipt',
    issuer: a.issuer,
    operation_id: a.operationId,
    action: a.actionKey.split(':')[0] ?? 'unknown',
    revision: a.approval.revision,
    approved_at: a.approval.at,
    channel: a.approval.channel,
    summary_sha256: hash(a.approval.operation.summary),
    terms_sha256: hash(stableJson(a.approval.operation.terms ?? null)),
    terms: publicTerms(a.approval.operation.terms as Record<string, unknown> | undefined),
    expires_at: a.approval.operation.expires_at,
    state: a.state,
  };
}

export function signReceipt(key: ReceiptKey, payload: ReceiptPayload): SignedReceipt {
  return { payload, kid: key.kid, alg: 'Ed25519', signature: sign(null, signingInput(payload), key.privateKey).toString('base64') };
}

/** Standalone check: needs only the receipt and Haat's public key. Never throws. */
export function verifyReceipt(receipt: unknown, publicKeyB64: string): { ok: true } | { ok: false; reason: string } {
  try {
    const r = receipt as SignedReceipt;
    if (!r || typeof r !== 'object' || !r.payload || typeof r.signature !== 'string') return { ok: false, reason: 'not a receipt' };
    if (r.alg !== 'Ed25519') return { ok: false, reason: 'unsupported algorithm' };
    if (r.payload.v !== 1 || r.payload.type !== 'haat.approval-receipt') return { ok: false, reason: 'unknown receipt type' };
    if (r.kid !== keyId(publicKeyB64)) return { ok: false, reason: 'receipt was signed by a different key' };
    const sig = Buffer.from(r.signature, 'base64');
    if (sig.length !== 64) return { ok: false, reason: 'bad signature length' };
    return verify(null, signingInput(r.payload), ed25519PublicKeyFromB64(publicKeyB64), sig) ? { ok: true } : { ok: false, reason: 'signature does not match the terms' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * Checks revealed text against a receipt: the summary and terms the person says they were shown
 * must hash to the signed values. Call verifyReceipt first; this only compares hashes.
 */
export function verifyApprovedText(receipt: SignedReceipt, shown: { summary: string; terms?: Record<string, unknown> }): boolean {
  return receipt.payload.summary_sha256 === hash(shown.summary) && receipt.payload.terms_sha256 === hash(stableJson(shown.terms ?? null));
}
