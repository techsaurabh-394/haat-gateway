import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt, generateP256, isPublicP256Jwk, jwkThumbprint, signEs256, verifyEs256 } from '../src/poppy/jwt.ts';

test('ES256 sign and verify round trip', () => {
  const k = generateP256();
  const t = signEs256({ typ: 'x' }, { a: 1 }, k.privateKey);
  const d = decodeJwt(t);
  assert.equal(d.header.alg, 'ES256');
  assert.equal(d.payload.a, 1);
  assert.ok(verifyEs256(d, k.publicJwk));
});

test('verification fails with another key or a tampered payload', () => {
  const k = generateP256();
  const other = generateP256();
  const t = signEs256({}, { a: 1 }, k.privateKey);
  assert.equal(verifyEs256(decodeJwt(t), other.publicJwk), false);
  const [h, , s] = t.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString('base64url')}.${s}`;
  assert.equal(verifyEs256(decodeJwt(forged), k.publicJwk), false);
});

test('alg other than ES256 is refused even with a valid signature', () => {
  const k = generateP256();
  const t = signEs256({}, { a: 1 }, k.privateKey);
  const d = decodeJwt(t);
  d.header.alg = 'none';
  assert.equal(verifyEs256(d, k.publicJwk), false);
});

test('RFC 7638 thumbprint is stable and ignores extra members', () => {
  const k = generateP256();
  const a = jwkThumbprint(k.publicJwk);
  const b = jwkThumbprint({ ...k.publicJwk, kid: 'x', use: 'sig' } as never);
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test('RFC 7638 thumbprint matches a known vector', () => {
  // EC P-256 key from RFC 7517 appendix A.1. Expected value computed independently in Python with
  // the RFC 7638 canonical form; the same Python code reproduces RFC 7638's own RSA example
  // (NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs), so the canonicalisation is checked against the RFC.
  const jwk = { kty: 'EC', crv: 'P-256', x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4', y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM' };
  assert.equal(jwkThumbprint(jwk), 'cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn-s');
});

test('private keys are not accepted as public JWKs', () => {
  const k = generateP256();
  assert.ok(isPublicP256Jwk(k.publicJwk));
  assert.equal(isPublicP256Jwk({ ...k.publicJwk, d: 'secret' }), false);
  assert.equal(isPublicP256Jwk({ kty: 'RSA', n: 'x', e: 'AQAB' }), false);
});

test('malformed tokens are rejected', () => {
  assert.throws(() => decodeJwt('a.b'));
  assert.throws(() => decodeJwt('###.###.###'));
  assert.throws(() => decodeJwt('x'.repeat(9000)));
  assert.throws(() => decodeJwt(`${Buffer.from('[]').toString('base64url')}.e30.AA`));
});
