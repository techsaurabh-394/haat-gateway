# Signed approval receipts

Every approved operation (an order or a cancellation) has a receipt: a record, signed by Haat, of
exactly what the person approved, when, and through which channel. In a dispute ("I never agreed to
that total") the receipt lets anyone check, with Haat's public key alone, what Haat recorded.

## What a receipt proves, and what it does not

Proves:
- Haat recorded an approval of these exact terms (summary and terms hashes, revision) at this time.
- The terms were not changed after signing: any edit breaks the signature.

Does not prove:
- That the seller delivered, or that the order was accepted (`state` is only what Haat knew when it
  issued the receipt; ask for the receipt again after the order settles).
- Who the person is. The receipt holds no phone, name, address or account key.
- That the receipt is the only record: Haat could issue receipts for approvals that never
  happened. A receipt is evidence from Haat, not an independent notary. Pair it with the person's
  own copy of the approval text.

## Privacy: hashes in the receipt, text with the owner

The approval summary names the delivery address, so it is not copied into the receipt. The receipt
carries `summary_sha256` and `terms_sha256` (SHA-256 of the exact text and exact terms shown, with
the address included) plus the commercial terms without `deliver_to` (seller, lines, total,
payment). The owner gets the full text back in the unsigned `approved` field and can reveal it in a
dispute; anyone can check it against the hashes.

## API

`GET /api/v1/operations/{operation_id}/receipt` (the owner's session or account; scope `orders:read`
when signed in). 404 until an approval has happened and for anyone who does not own the operation.

    { "payload": { "v": 1, "type": "haat.approval-receipt", "issuer": "...", "operation_id": "...",
                   "action": "order", "revision": "...", "approved_at": "...", "channel": "header|link",
                   "summary_sha256": "...", "terms_sha256": "...", "terms": { ...no deliver_to... },
                   "expires_at": "...", "state": "performed" },
      "kid": "...", "alg": "Ed25519", "signature": "...",
      "approved": { "summary": "...", "terms": { ... } } }   // unsigned, owner only

`GET /.well-known/haat-receipt-keys.json` lists the public key (`kid`, `alg`, `public_key`).

## Verifying

    import { verifyReceipt, verifyApprovedText } from './src/receipts/receipts.ts';
    verifyReceipt(receipt, publicKeyB64);          // { ok: true } or { ok: false, reason }
    verifyApprovedText(receipt, receipt.approved); // true when the revealed text matches the hashes

The signature is Ed25519 over `"haat-approval-receipt-v1\n" + stable JSON of payload` (keys sorted).
`approved` is not signed. Ignore it unless `verifyApprovedText` passes.

## Keys

Set `HAAT_RECEIPT_KEY` (base64 Ed25519 seed) to keep one key across deployments. Without it a key is
created on first start and kept in the database, so it survives restarts. The receipt key is
separate from the Beckn signing key.

## Limits

- No key rotation yet: the key-list endpoint holds only the current key. Changing the key makes old
  receipts fail against the new key. Keep the old public key if you change it.
- The approval record lives as long as the operation is remembered (at least 24 hours after its last
  revision expires, as the Poppy spec requires). A person who needs a receipt long term should
  download it right after approving.
- If a definite failure frees an operation for another try, the next approval replaces the recorded
  one. The receipt always describes the approval that was performed last.
