/** Poppy sign-in (spec section 4) end to end, including the attacks it is designed to stop. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, personSignsIn, type Company } from '../agent/personal-agent.ts';
import { b64u, randomId, sha256 } from '../src/util/b64.ts';

let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;
const PHONE = '9123456780';
const OTP = '123456';
const ALL = ['orders:read', 'orders:write', 'addresses'];
const person = (o: Partial<Parameters<typeof personSignsIn>[1]> = {}) => (url: string) => personSignsIn(url, { phone: PHONE, otp: OTP, ...o });

before(async () => {
  net = await startNetwork({ stageSec: 30, searchWindowMs: 400 });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
});

/** Starts a sign-in and returns the authorization URL plus what the agent must keep. */
function authorizeUrl(scopes: string[], over: Record<string, string> = {}) {
  const verifier = randomId('', 48);
  const state = randomId('', 8);
  const u = new URL(company.as!.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: agent.clientId, redirect_uri: `${agent.base}/oauth/callback`, scope: scopes.join(' '), state,
    code_challenge: b64u(sha256(verifier)), code_challenge_method: 'S256', ...over,
  }).toString();
  return { url: u.href, verifier, state };
}

async function codeFor(scopes = ALL) {
  const a = authorizeUrl(scopes);
  const back = new URL(await personSignsIn(a.url, { phone: PHONE, otp: OTP }));
  return { code: back.searchParams.get('code')!, verifier: a.verifier, back };
}

test('discovery finds the issuer and checks it vouches for the domain (3.2)', () => {
  assert.equal(company.issuer, net.gatewayUrl);
  assert.equal(company.identifier, company.issuer);
  assert.ok(company.as!.grant_types_supported.includes('refresh_token'));
  assert.deepEqual(company.poppy.auth.scope_hints['orders:write'], { changes: 'irreversible', personal_data: true });
});

test('Direct Sign-In: PKCE, iss in the redirect, tokens, signed-in requests', async () => {
  const t = await agent.signIn(company, ALL, person());
  assert.deepEqual(t.scopes.sort(), [...ALL].sort());
  const sid = agent.newSession();
  const r = await agent.call(company, sid, 'GET', '/api/v1/account/addresses', { signedIn: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.addresses, []);
});

test('the person can approve fewer scopes; the token says which (4.7)', async () => {
  const a2 = await new PersonalAgent().start();
  try {
    const c = await a2.discover(net.gatewayUrl);
    const t = await a2.signIn(c, ALL, person({ scopes: ['orders:read'] }));
    assert.deepEqual(t.scopes, ['orders:read']);
    const sid = a2.newSession();
    const denied = await a2.call(c, sid, 'GET', '/api/v1/account/addresses', { signedIn: true });
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get('www-authenticate')!, /insufficient_scope/);
  } finally {
    await a2.stop();
  }
});

test('declining sends access_denied back with iss (4.2)', async () => {
  const a = authorizeUrl(ALL);
  const back = new URL(await personSignsIn(a.url, { phone: PHONE, otp: OTP, decline: true }));
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('iss'), company.issuer);
  assert.equal(back.searchParams.get('state'), a.state);
});

test('an unregistered redirect_uri gets an error page, never a redirect', async () => {
  const a = authorizeUrl(ALL, { redirect_uri: 'https://attacker.example/steal' });
  const res = await fetch(a.url, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
});

test('PKCE is required, unknown scopes are refused', async () => {
  const noPkce = new URL(authorizeUrl(ALL, { code_challenge_method: 'plain' }).url);
  const r1 = new URL((await fetch(noPkce, { redirect: 'manual' })).headers.get('location')!);
  assert.equal(r1.searchParams.get('error'), 'invalid_request');
  const r2 = new URL((await fetch(authorizeUrl(['admin']).url, { redirect: 'manual' })).headers.get('location')!);
  assert.equal(r2.searchParams.get('error'), 'invalid_scope');
});

test('a wrong code_verifier, a reused code, or a mismatched redirect_uri get invalid_grant', async () => {
  const c1 = await codeFor();
  const bad = await agent.tokenRequest(company, { grant_type: 'authorization_code', code: c1.code, redirect_uri: `${agent.base}/oauth/callback`, code_verifier: randomId('', 48) });
  assert.equal(bad.body.error, 'invalid_grant');
  const reused = await agent.tokenRequest(company, { grant_type: 'authorization_code', code: c1.code, redirect_uri: `${agent.base}/oauth/callback`, code_verifier: c1.verifier });
  assert.equal(reused.body.error, 'invalid_grant'); // one-time, even after a failed attempt
  const c2 = await codeFor();
  const wrongUri = await agent.tokenRequest(company, { grant_type: 'authorization_code', code: c2.code, redirect_uri: `${agent.base}/other`, code_verifier: c2.verifier });
  assert.equal(wrongUri.body.error, 'invalid_grant');
});

test('client assertions: aud must be the issuer as a string; exp, jti and signature are checked (4.1)', async () => {
  const form = { grant_type: 'refresh_token', refresh_token: 'x' };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['aud array', { aud: [company.issuer] }],
    ['aud = token endpoint', { aud: company.as!.token_endpoint }],
    ['expired', { iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 }],
    ['no exp', { exp: undefined }],
    ['sub differs', { sub: 'https://someone.example/agent.json' }],
  ];
  for (const [name, over] of cases) {
    const r = await agent.tokenRequest(company, form, over);
    assert.equal(r.status, 401, name);
    assert.equal(r.body.error, 'invalid_client', name);
  }
  const jti = randomId('', 16);
  const first = await agent.tokenRequest(company, form, { jti });
  assert.equal(first.body.error, 'invalid_grant'); // the assertion passed; the token was bad
  const replay = await agent.tokenRequest(company, form, { jti });
  assert.equal(replay.body.error, 'invalid_client');
});

test('a PS384 client assertion is accepted (4.1)', async () => {
  const a = await new PersonalAgent({ ps384: true }).start();
  try {
    const c = await a.discover(net.gatewayUrl);
    const r = await a.tokenRequest(c, { grant_type: 'refresh_token', refresh_token: 'x' }, {}, true);
    assert.equal(r.body.error, 'invalid_grant'); // authenticated fine
  } finally {
    await a.stop();
  }
});

test('refresh can narrow scopes but never widen them (4.4)', async () => {
  const a = await new PersonalAgent().start();
  try {
    const c = await a.discover(net.gatewayUrl);
    await a.signIn(c, ['orders:read'], person({ scopes: ['orders:read'] }));
    const wider = await a.refresh(c, 'orders:read addresses');
    assert.equal(wider.body.error, 'invalid_scope');
    const same = await a.refresh(c);
    assert.equal(same.status, 200);
    assert.equal(same.body.refresh_token, undefined);
  } finally {
    await a.stop();
  }
});

test("another client's access token is refused with invalid_session (5.3 step 3)", async () => {
  const thief = await new PersonalAgent().start();
  try {
    const c = await thief.discover(net.gatewayUrl);
    thief.tokens.set(c.identifier, agent.tokens.get(company.identifier)!); // stolen token
    const r = await thief.call(c, thief.newSession(), 'GET', '/api/v1/account/addresses', { signedIn: true });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_session');
  } finally {
    await thief.stop();
  }
});

test('saved addresses: add one, then order with delivery_address_id', async () => {
  const sid = agent.newSession();
  const add = await agent.call(company, sid, 'POST', '/api/v1/account/addresses', { signedIn: true, body: { label: 'Home', contact_name: 'Asha', contact_phone: '9876501234', address: { building: 'B-12', locality: 'Lanka', city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const b = (await agent.call(company, sid, 'GET', `/api/v1/search?q=${encodeURIComponent('1 kilo namak')}`, { signedIn: true })).body.suggested_basket;
  const cart = { bpp_id: b.bpp_id, provider_id: b.provider_id, items: b.items.map((i: any) => ({ id: i.id, count: i.count })), delivery_address_id: add.body.id };
  const placed = await agent.callWithApproval(company, sid, 'POST', '/api/v1/orders', cart, async (op) => /Asha/.test(op.summary), {}, true);
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  // Orders belong to the account: a different Session of the same account sees it.
  const list = await agent.call(company, agent.newSession(), 'GET', '/api/v1/orders', { signedIn: true });
  assert.ok(list.body.orders.some((o: any) => o.order_id === placed.body.order_id));
});

test('the same person signing in through another agent reaches the same account', async () => {
  const other = await new PersonalAgent({ name: 'Another agent' }).start();
  try {
    const c = await other.discover(net.gatewayUrl);
    await other.signIn(c, ALL, person());
    const r = await other.call(c, other.newSession(), 'GET', '/api/v1/account/addresses', { signedIn: true });
    assert.equal(r.body.addresses[0].label, 'Home');
  } finally {
    await other.stop();
  }
});

test('a Session cannot switch accounts (5.4)', async () => {
  const a = await new PersonalAgent().start();
  try {
    const c = await a.discover(net.gatewayUrl);
    await a.signIn(c, ALL, (url) => personSignsIn(url, { phone: '9000000001', otp: OTP }));
    const sid = a.newSession();
    assert.equal((await a.call(c, sid, 'GET', '/api/v1/orders', { signedIn: true })).status, 200);
    await a.signIn(c, ALL, (url) => personSignsIn(url, { phone: '9000000002', otp: OTP }));
    const r = await a.call(c, sid, 'GET', '/api/v1/orders', { signedIn: true });
    assert.equal(r.body.error, 'invalid_session');
  } finally {
    await a.stop();
  }
});

test('conversation: "my orders" signed out asks for sign-in with an authorization event (8.11)', async () => {
  const sid = agent.newSession();
  const r = await agent.say(company, sid, null, { text: 'my orders dikhao' });
  const authz = r.body.events.find((e: any) => e.type === 'authorization');
  assert.deepEqual([authz?.error, authz?.scope], ['insufficient_scope', 'orders:read']);
  const signedIn = await agent.say(company, sid, r.body.conversation_id, { text: 'my orders' }, 10, true);
  assert.ok(signedIn.body.events.some((e: any) => e.message?.data?.orders?.length >= 1));
  // Now it used the account: a signed-out request on it gets a challenge (8.11, 5.5).
  const out = await agent.call(company, sid, 'GET', `/poppy/conversations/${r.body.conversation_id}/events`);
  assert.equal(out.status, 401);
  assert.match(out.headers.get('www-authenticate')!, /Bearer scope=/);
});

test('conversation: signed in, the saved address is used for the quote', async () => {
  const sid = agent.newSession();
  let r = await agent.say(company, sid, null, { text: '1 kilo chawal' }, 10, true);
  const id = r.body.conversation_id;
  r = await agent.say(company, sid, id, { text: 'order kar do' }, 10, true);
  const op = r.body.events.filter((e: any) => e.message?.operation).at(-1)?.message.operation;
  assert.ok(op, JSON.stringify(r.body.events.at(-1)));
  assert.match(op.summary, /Asha/);
});

test('sign-out revokes the refresh token and its access tokens (4.6, 5.5)', async () => {
  const token = agent.tokens.get(company.identifier)!;
  assert.equal(await agent.signOut(company), 200);
  agent.tokens.set(company.identifier, token); // try to keep using it
  const r = await agent.call(company, agent.newSession(), 'GET', '/api/v1/orders', { signedIn: true });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate')!, /invalid_token/);
  agent.tokens.delete(company.identifier);
});
