/**
 * Signed approval receipts: issued only after an approval, bound to the exact approved terms,
 * checkable with the public key alone, private to the owner, and free of personal data.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';
import { verifyReceipt, verifyApprovedText, signReceipt, buildPayload, loadReceiptKey, keyId } from '../src/receipts/receipts.ts';
import { generateEd25519 } from '../src/beckn/signing.ts';
import { MemoryKV } from '../src/store/kv.ts';

const delivery = { name: 'Test User', phone: '9876543210', address: { locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } };
const dir = mkdtempSync(join(tmpdir(), 'haat-receipt-'));
let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;

before(async () => {
  net = await startNetwork({ stageSec: 60, searchWindowMs: 400, extraGatewayConfig: { dbPath: join(dir, 'haat.db') } });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function publicKey(): Promise<{ kid: string; public_key: string }> {
  const url = `${net.gatewayUrl}/.well-known/haat-receipt-keys.json`;
  // After restartGateway() the HTTP client may still hold a keep-alive socket to the old server,
  // which fails once with ECONNRESET. That is the test harness, not the gateway: retry once.
  const res = await fetch(url).catch(() => fetch(url));
  return (await res.json()).keys[0];
}

async function order(sid: string, query: string) {
  const b = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent(query)}`)).body.suggested_basket;
  const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery };
  const op = (await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart })).body.operation;
  return { cart, op };
}

test('no receipt before approval; after approval the receipt verifies and matches the approved terms', async () => {
  const sid = agent.newSession();
  const { cart, op } = await order(sid, '1 kilo chini');
  assert.equal((await agent.call(company, sid, 'GET', `/api/v1/operations/${op.operation_id}/receipt`)).status, 404, 'nothing approved yet');

  const placed = await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: op.operation_id, revision: op.revision } });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));

  const r = await agent.call(company, sid, 'GET', `/api/v1/operations/${op.operation_id}/receipt`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const key = await publicKey();
  assert.deepEqual(verifyReceipt(r.body, key.public_key), { ok: true });
  assert.equal(r.body.kid, key.kid);
  assert.equal(r.body.payload.operation_id, op.operation_id);
  assert.equal(r.body.payload.revision, op.revision);
  // The receipt holds hashes of the exact text the person was shown; the owner gets the text back.
  assert.equal(r.body.approved.summary, op.summary);
  assert.equal(verifyApprovedText(r.body, r.body.approved), true);
  assert.equal(verifyApprovedText(r.body, { ...r.body.approved, summary: op.summary + '!' }), false, 'a changed summary must not match');
  assert.equal(verifyApprovedText(r.body, { ...r.body.approved, terms: { ...op.terms, total: { amount: '1.00', currency: 'INR' } } }), false, 'changed terms must not match');
  assert.equal(r.body.payload.terms.total.amount, op.terms.total.amount, 'the signed total is readable without revealing anything else');
  assert.equal(r.body.payload.terms.deliver_to, undefined);
  assert.equal(r.body.payload.action, 'order');
  assert.equal(r.body.payload.channel, 'header');
  assert.equal(r.body.payload.state, 'performed');
  assert.ok(Math.abs(Date.now() - Date.parse(r.body.payload.approved_at)) < 30_000);
});

test('any change to the receipt breaks the signature', async () => {
  const sid = agent.newSession();
  const { cart, op } = await order(sid, '1 litre doodh');
  await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: op.operation_id, revision: op.revision } });
  const good = (await agent.call(company, sid, 'GET', `/api/v1/operations/${op.operation_id}/receipt`)).body;
  const key = (await publicKey()).public_key;
  assert.equal(verifyReceipt(good, key).ok, true);

  const edits: Array<[string, (c: any) => void]> = [
    ['summary hash', (c) => (c.payload.summary_sha256 = 'x' + c.payload.summary_sha256.slice(1))],
    ['terms hash', (c) => (c.payload.terms_sha256 = 'x' + c.payload.terms_sha256.slice(1))],
    ['amount in terms', (c) => (c.payload.terms = { ...(c.payload.terms ?? {}), total: { amount: '1.00', currency: 'INR' } })],
    ['time', (c) => (c.payload.approved_at = new Date(Date.parse(c.payload.approved_at) - 3600_000).toISOString())],
    ['operation', (c) => (c.payload.operation_id = 'op_other')],
    ['revision', (c) => (c.payload.revision += 'x')],
    ['channel', (c) => (c.payload.channel = 'link')],
    ['state', (c) => (c.payload.state = 'pending')],
    ['extra field', (c) => (c.payload.note = 'added')],
    ['signature', (c) => (c.signature = Buffer.alloc(64).toString('base64'))],
  ];
  for (const [what, edit] of edits) {
    const bad = structuredClone(good);
    edit(bad);
    assert.equal(verifyReceipt(bad, key).ok, false, `changing ${what} must fail verification`);
  }
});

test('another session or a different key cannot use or fake a receipt', async () => {
  const sid = agent.newSession();
  const { cart, op } = await order(sid, '1 kilo aloo');
  await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: op.operation_id, revision: op.revision } });
  const other = agent.newSession();
  assert.equal((await agent.call(company, other, 'GET', `/api/v1/operations/${op.operation_id}/receipt`)).status, 404, 'receipts are private to the owner');
  assert.equal((await fetch(`${net.gatewayUrl}/api/v1/operations/${op.operation_id}/receipt`)).status, 400, 'needs a session');

  const real = (await agent.call(company, sid, 'GET', `/api/v1/operations/${op.operation_id}/receipt`)).body;
  const attacker = loadReceiptKey(new MemoryKV(), generateEd25519().privateKeyB64);
  const forged = signReceipt(attacker, real.payload);
  const key = await publicKey();
  assert.deepEqual(verifyReceipt(forged, key.public_key), { ok: false, reason: 'receipt was signed by a different key' });
  const sameKid = { ...forged, kid: key.kid };
  assert.deepEqual(verifyReceipt(sameKid, key.public_key), { ok: false, reason: 'signature does not match the terms' });
});

test('a receipt holds no personal data and no secrets', async () => {
  const sid = agent.newSession();
  const { cart, op } = await order(sid, '1 kilo chini');
  await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: op.operation_id, revision: op.revision } });
  const body = (await agent.call(company, sid, 'GET', `/api/v1/operations/${op.operation_id}/receipt`)).body;
  // The signed part (what the person shows a third party) must carry no personal data.
  const signed = JSON.stringify({ payload: body.payload, kid: body.kid, alg: body.alg, signature: body.signature });
  for (const s of ['9876543210', '3210', 'Test User', 'Lanka', '221005', 'ownerKey', 'userKey', 'sessionKey']) assert.ok(!signed.includes(s), `receipt leaked ${s}`);
  // The full text goes back to its owner only, and it does name the delivery address.
  assert.ok(body.approved.summary.includes('Lanka'));
});

test('the signing key survives a gateway restart, so old receipts still verify', async () => {
  const sid = agent.newSession();
  const { cart, op } = await order(sid, '1 litre doodh');
  await agent.call(company, sid, 'POST', '/api/v1/orders', { body: cart, approval: { operation_id: op.operation_id, revision: op.revision } });
  const before = (await agent.call(company, sid, 'GET', `/api/v1/operations/${op.operation_id}/receipt`)).body;
  const keyBefore = await publicKey();
  await net.restartGateway();
  const keyAfter = await publicKey();
  assert.deepEqual(keyAfter, keyBefore);
  assert.equal(verifyReceipt(before, keyAfter.public_key).ok, true);
  const after = (await agent.call(company, sid, 'GET', `/api/v1/operations/${op.operation_id}/receipt`)).body;
  assert.equal(after.payload.approved_at, before.payload.approved_at, 'the approval time is the recorded one, not "now"');
  assert.equal(after.signature, before.signature, 'Ed25519 signatures are deterministic: same terms, same signature');
});

test('verifyReceipt never throws on junk', () => {
  const k = generateEd25519().publicKeyB64;
  for (const junk of [null, undefined, 1, 'x', [], {}, { payload: {} }, { payload: { v: 1, type: 'haat.approval-receipt' }, signature: 5 }, { payload: { v: 2 }, signature: 'AA==', alg: 'Ed25519' }]) {
    assert.equal(verifyReceipt(junk, k).ok, false);
  }
  const key = loadReceiptKey(new MemoryKV());
  const p = buildPayload({ issuer: 'https://x', operationId: 'op_1', actionKey: 'order:a:b', state: 'performed', approval: { at: new Date().toISOString(), revision: 'r', channel: 'header', operation: { operation_id: 'op_1', revision: 'r', summary: 's', expires_at: new Date().toISOString() } } });
  assert.equal(verifyReceipt(signReceipt(key, p), key.publicKeyB64).ok, true);
  assert.equal(key.kid, keyId(key.publicKeyB64));
  assert.equal(verifyReceipt({ ...signReceipt(key, p), signature: 'not base64 !!' }, key.publicKeyB64).ok, false);
});
