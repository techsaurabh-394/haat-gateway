import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { startNetwork } from '../mock-network/network.ts';
import { ed25519PublicKeyFromB64 } from '../src/beckn/signing.ts';
import { decryptChallenge, encryptChallengeAsRegistry, generateOndcKeys, ONDC_REGISTRY, signRequestId, siteVerificationHtml, subscribeTemplate } from '../src/ondc/onboarding.ts';

test('key formats match what ONDC registers', () => {
  const k = generateOndcKeys();
  assert.equal(Buffer.from(k.signingPublicKey, 'base64').length, 32);
  assert.match(k.encryptionPublicKey, /^MCowBQYDK2VuAyEA/); // X25519 SPKI DER, as in ONDC's examples
  assert.equal(createPublicKey({ key: Buffer.from(k.encryptionPublicKey, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'x25519');
  for (const env of Object.values(ONDC_REGISTRY)) {
    assert.equal(createPublicKey({ key: Buffer.from(env.encryptionPublicKey, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'x25519');
  }
});

test('the signed request_id verifies with the signing public key, without hashing', () => {
  const k = generateOndcKeys();
  const id = '6a6abf53-674f-4d6d-a52b-62e3fda55e04';
  const sig = signRequestId(id, k.signingPrivateKey);
  assert.ok(verify(null, Buffer.from(id), ed25519PublicKeyFromB64(k.signingPublicKey), Buffer.from(sig, 'base64')));
  assert.match(siteVerificationHtml(sig), new RegExp(`<meta name="ondc-site-verification" content="${sig.replace(/[+/]/g, '\\$&')}" />`));
});

test('on_subscribe challenge: what the registry encrypts, we decrypt (AES-256-ECB over X25519)', () => {
  const ours = generateOndcKeys();
  const registry = generateKeyPairSync('x25519');
  const regPriv = registry.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const regPub = registry.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const challenge = encryptChallengeAsRegistry('ONDC is a Great Initiative!!', regPriv, ours.encryptionPublicKey);
  assert.equal(decryptChallenge(challenge, ours.encryptionPrivateKey, regPub), 'ONDC is a Great Initiative!!');
  assert.throws(() => decryptChallenge(challenge, generateOndcKeys().encryptionPrivateKey, regPub));
});

test('subscribe template: ops_no 1 (buyer app), keys filled, legal fields left for the owner', () => {
  const k = generateOndcKeys();
  const t = subscribeTemplate({ subscriberId: 'haat.example.in', uniqueKeyId: 'k1', requestId: 'r1', keys: k, callbackPath: '/ondc', subscriberPath: '/beckn', domains: ['ONDC:RET10'], cities: ['std:0542'] }) as any;
  assert.equal(t.context.operation.ops_no, 1);
  assert.equal(t.message.entity.key_pair.signing_public_key, k.signingPublicKey);
  assert.equal(t.message.network_participant[0].type, 'buyerApp');
  assert.match(JSON.stringify(t), /FILL_IN/);
  assert.doesNotMatch(JSON.stringify(t), new RegExp(k.signingPrivateKey.replace(/[+/]/g, '\\$&')));
});

test('the gateway serves site verification and answers on_subscribe', async () => {
  const k = generateOndcKeys();
  const registry = generateKeyPairSync('x25519');
  const regPub = registry.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const regPriv = registry.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const net = await startNetwork({
    extraGatewayConfig: { ondc: { onboarding: { requestId: 'req-123', encryptionPrivateKey: k.encryptionPrivateKey, registryEncryptionPublicKey: regPub, callbackPath: '/ondc' } } },
  });
  try {
    const page = await (await fetch(`${net.gatewayUrl}/ondc-site-verification.html`)).text();
    const sig = /content="([^"]+)"/.exec(page)![1]!;
    const bap = net.gateway.config.bap;
    assert.ok(verify(null, Buffer.from('req-123'), ed25519PublicKeyFromB64(bap.publicKeyB64), Buffer.from(sig, 'base64')));
    const challenge = encryptChallengeAsRegistry('secret-answer', regPriv, k.encryptionPublicKey);
    const r = await fetch(`${net.gatewayUrl}/ondc/on_subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscriber_id: bap.subscriberId, challenge }) });
    assert.deepEqual(await r.json(), { answer: 'secret-answer' });
  } finally {
    await net.stop();
  }
});
