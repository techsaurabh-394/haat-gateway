import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorizationHeader, ed25519PrivateKeyFromB64, generateEd25519, parseAuthorizationHeader, verifyAuthorizationHeader, blake512B64 } from '../src/beckn/signing.ts';

function setup() {
  const k = generateEd25519();
  const key = { subscriberId: 'bap.example', uniqueKeyId: 'k1', privateKey: k.privateKey, publicKeyB64: k.publicKeyB64 };
  const lookup = async (sid: string, uk: string) => (sid === 'bap.example' && uk === 'k1' ? k.publicKeyB64 : null);
  return { k, key, lookup };
}

test('sign and verify a Beckn request', async () => {
  const { key, lookup } = setup();
  const body = JSON.stringify({ context: { action: 'search' }, message: {} });
  const h = createAuthorizationHeader(key, body);
  const p = parseAuthorizationHeader(h)!;
  assert.equal(p.subscriberId, 'bap.example');
  assert.equal(p.headers, '(created) (expires) digest');
  assert.deepEqual(await verifyAuthorizationHeader(h, body, lookup), { ok: true, subscriberId: 'bap.example' });
});

test('a changed body fails verification', async () => {
  const { key, lookup } = setup();
  const h = createAuthorizationHeader(key, '{"a":1}');
  const r = await verifyAuthorizationHeader(h, '{"a":2}', lookup);
  assert.equal(r.ok, false);
});

test('expired and future signatures fail', async () => {
  const { key, lookup } = setup();
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await verifyAuthorizationHeader(createAuthorizationHeader(key, 'x', now - 1000, 60), 'x', lookup)).ok, false);
  assert.equal((await verifyAuthorizationHeader(createAuthorizationHeader(key, 'x', now + 1000, 60), 'x', lookup)).ok, false);
});

test('unknown signer and wrong key fail', async () => {
  const { key } = setup();
  const other = generateEd25519();
  const h = createAuthorizationHeader(key, 'x');
  assert.equal((await verifyAuthorizationHeader(h, 'x', async () => null)).ok, false);
  assert.equal((await verifyAuthorizationHeader(h, 'x', async () => other.publicKeyB64)).ok, false);
});

test('malformed headers are rejected', async () => {
  const { lookup } = setup();
  for (const h of [undefined, '', 'Bearer x', 'Signature keyId="a|b|rsa",signature="x"']) {
    assert.equal((await verifyAuthorizationHeader(h, 'x', lookup)).ok, false);
  }
});

test('private key round-trips through the raw base64 seed format', async () => {
  const { k, lookup } = setup();
  const restored = ed25519PrivateKeyFromB64(k.privateKeyB64);
  const h = createAuthorizationHeader({ subscriberId: 'bap.example', uniqueKeyId: 'k1', privateKey: restored, publicKeyB64: k.publicKeyB64 }, 'body');
  assert.equal((await verifyAuthorizationHeader(h, 'body', lookup)).ok, true);
});

test('BLAKE2b-512 digest of the empty string matches the published test vector', () => {
  // RFC 7693 / reference: BLAKE2b-512("") = 786a02f7...ce
  assert.equal(Buffer.from(blake512B64(''), 'base64').toString('hex').slice(0, 16), '786a02f742015903');
});
