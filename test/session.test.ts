import { test } from 'node:test';
import type { KeyObject } from 'node:crypto';
import assert from 'node:assert/strict';
import { offlineAgent } from './helpers.ts';
import { SessionError } from '../src/poppy/session.ts';
import { generateP256, jwkThumbprint, signEs256 } from '../src/poppy/jwt.ts';
import { randomId } from '../src/util/b64.ts';

const URL_ = 'https://shop.example/api/v1/search';

async function rejects(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (e: unknown) => e instanceof SessionError && re.test((e as Error).message));
}

test('a correctly signed Session JWT is accepted and starts a Session', async () => {
  const { agent, company, verifier } = offlineAgent();
  const sid = agent.newSession();
  const s = await verifier.verify(agent.sessionJwt(company, sid, 'GET', URL_), 'GET', URL_);
  assert.equal(s.clientId, 'https://agent.example/agent.json');
  assert.equal(s.sid, sid);
  assert.equal(s.isNew, true);
  const again = await verifier.verify(agent.sessionJwt(company, sid, 'GET', URL_), 'GET', URL_);
  assert.equal(again.isNew, false);
  assert.equal(again.sub, s.sub);
});

test('missing header', async () => {
  const { verifier } = offlineAgent();
  await rejects(verifier.verify(undefined, 'GET', URL_), /missing/);
});

test('wrong audience, method or URL is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const sid = agent.newSession();
  await rejects(verifier.verify(agent.sessionJwt({ ...company, identifier: 'https://evil.example' }, sid, 'GET', URL_), 'GET', URL_), /aud/);
  await rejects(verifier.verify(agent.sessionJwt(company, sid, 'POST', URL_), 'GET', URL_), /htm/);
  await rejects(verifier.verify(agent.sessionJwt(company, sid, 'GET', 'https://shop.example/api/v1/orders'), 'GET', URL_), /htu/);
});

test('stale iat is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const t = agent.sessionJwt(company, agent.newSession(), 'GET', URL_, undefined, { iat: Math.floor(Date.now() / 1000) - 600 });
  await rejects(verifier.verify(t, 'GET', URL_), /iat/);
});

test('a replayed JWT (same jti) is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const t = agent.sessionJwt(company, agent.newSession(), 'GET', URL_);
  await verifier.verify(t, 'GET', URL_);
  await rejects(verifier.verify(t, 'GET', URL_), /replayed/);
});

test('ath without an access token is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const t = agent.sessionJwt(company, agent.newSession(), 'GET', URL_, 'tok');
  await rejects(verifier.verify(t, 'GET', URL_), /ath/);
});

test('a Session JWT signed directly with the root key (no delegation) is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const t = signEs256(
    { typ: 'poppy-session+jwt', kid: agent.rootKid },
    { iss: agent.clientId, aud: company.identifier, sid: agent.newSession(), sub: 'usr_x', htm: 'GET', htu: URL_, iat: Math.floor(Date.now() / 1000), jti: randomId('', 16) },
    agent.root.privateKey,
  );
  await rejects(verifier.verify(t, 'GET', URL_), /delegation/);
});

test('a delegation signed by an unknown key is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const rogue = generateP256();
  const dk = generateP256();
  const now = Math.floor(Date.now() / 1000);
  const dlg = signEs256({ typ: 'pap-delegation+jwt', kid: jwkThumbprint(rogue.publicJwk) }, { iss: agent.clientId, cnf: { jwk: dk.publicJwk }, iat: now, exp: now + 3600, jti: randomId('', 12) }, rogue.privateKey);
  const t = signEs256({ typ: 'poppy-session+jwt', kid: jwkThumbprint(dk.publicJwk), pap_dlg: dlg }, { iss: agent.clientId, aud: company.identifier, sid: agent.newSession(), sub: 'usr_x', htm: 'GET', htu: URL_, iat: now, jti: randomId('', 16) }, dk.privateKey);
  await rejects(verifier.verify(t, 'GET', URL_), /kid not found/);
});

function forgeWithDelegation(agent: ReturnType<typeof offlineAgent>['agent'], company: ReturnType<typeof offlineAgent>['company'], dlgClaims: Record<string, unknown>, dlgHeader: Record<string, unknown> = {}) {
  const dk = generateP256();
  const now = Math.floor(Date.now() / 1000);
  const dlg = signEs256({ typ: 'pap-delegation+jwt', kid: agent.rootKid, ...dlgHeader }, { iss: agent.clientId, cnf: { jwk: dk.publicJwk }, iat: now, exp: now + 3600, jti: randomId('', 12), ...dlgClaims }, agent.root.privateKey);
  return signEs256({ typ: 'poppy-session+jwt', kid: jwkThumbprint(dk.publicJwk), pap_dlg: dlg }, { iss: agent.clientId, aud: company.identifier, sid: agent.newSession(), sub: 'usr_x', htm: 'GET', htu: URL_, iat: now, jti: randomId('', 16) }, dk.privateKey);
}

test('expired delegation, over-long delegation, and wrong delegation typ are rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const now = Math.floor(Date.now() / 1000);
  await rejects(verifier.verify(forgeWithDelegation(agent, company, { iat: now - 7200, exp: now - 60 }), 'GET', URL_), /expired/);
  await rejects(verifier.verify(forgeWithDelegation(agent, company, { iat: now, exp: now + 25 * 3600 }), 'GET', URL_), /24 hours/);
  await rejects(verifier.verify(forgeWithDelegation(agent, company, {}, { typ: 'JWT' }), 'GET', URL_), /typ/);
});

test('a delegation carrying a private key member is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const dk = generateP256();
  const priv = dk.privateKey.export({ format: 'jwk' }) as Record<string, string>;
  await rejects(verifier.verify(forgeWithDelegation(agent, company, { cnf: { jwk: { ...dk.publicJwk, d: priv.d } } }), 'GET', URL_), /cnf/);
});

test('kid must be the delegated key thumbprint', async () => {
  const { agent, company, verifier } = offlineAgent();
  const good = agent.sessionJwt(company, agent.newSession(), 'GET', URL_);
  const [h, p] = good.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
  header.kid = 'not-the-thumbprint';
  // Re-sign with the agent's delegated key so only the kid is wrong.
  const userId = agent.userId(company);
  const d = (agent as unknown as { delegated: Map<string, { key: KeyObject }> }).delegated.get(userId)!;
  const t = signEs256(header, JSON.parse(Buffer.from(p!, 'base64url').toString()), d.key);
  await rejects(verifier.verify(t, 'GET', URL_), /thumbprint/);
});

test('a Session cannot change its User ID', async () => {
  const { agent, company, verifier } = offlineAgent();
  const sid = agent.newSession();
  await verifier.verify(agent.sessionJwt(company, sid, 'GET', URL_), 'GET', URL_);
  await rejects(verifier.verify(agent.sessionJwt(company, sid, 'GET', URL_, undefined, { sub: 'usr_someone_else' }), 'GET', URL_), /changed/);
});

test('an ended Session is rejected', async () => {
  const { agent, company, verifier } = offlineAgent();
  const sid = agent.newSession();
  const s = await verifier.verify(agent.sessionJwt(company, sid, 'GET', URL_), 'GET', URL_);
  verifier.end(s.clientId, sid);
  await rejects(verifier.verify(agent.sessionJwt(company, sid, 'GET', URL_), 'GET', URL_), /ended/);
});

test('client metadata whose client_id differs from its URL is rejected', async () => {
  const { agent, company, verifier, docs } = offlineAgent();
  docs['https://agent.example/agent.json'] = { ...agent.metadata(), client_id: 'https://other.example/agent.json' };
  await rejects(verifier.verify(agent.sessionJwt(company, agent.newSession(), 'GET', URL_), 'GET', URL_), /client_id/);
});

test('jwks_uri on another domain is rejected', async () => {
  const { agent, company, verifier, docs } = offlineAgent();
  docs['https://agent.example/agent.json'] = { ...agent.metadata(), jwks_uri: 'https://keys.attacker.example/jwks.json' };
  await rejects(verifier.verify(agent.sessionJwt(company, agent.newSession(), 'GET', URL_), 'GET', URL_), /same domain/);
});

test('http client_id is refused unless dev mode allows loopback', async () => {
  const { agent, company, verifier } = offlineAgent();
  agent.clientId = 'http://agent.example/agent.json';
  await rejects(verifier.verify(agent.sessionJwt(company, agent.newSession(), 'GET', URL_), 'GET', URL_), /https/);
});

test('a failing client metadata URL is not fetched again for a minute', async () => {
  const { agent, company, verifier, docs } = offlineAgent();
  delete docs['https://agent.example/agent.json'];
  let calls = 0;
  const original = verifier.resolver.fetchJson;
  verifier.resolver.fetchJson = async (u: string) => { calls++; return original(u); };
  await rejects(verifier.verify(agent.sessionJwt(company, agent.newSession(), 'GET', URL_), 'GET', URL_), /client metadata/);
  await rejects(verifier.verify(agent.sessionJwt(company, agent.newSession(), 'GET', URL_), 'GET', URL_), /recently failed/);
  assert.equal(calls, 1);
});
