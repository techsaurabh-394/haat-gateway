/** Section 9 (task coverage), SSE streaming (8.6), PS384 delegations (5.2), wait/cursor errors (8.13). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startNetwork } from '../mock-network/network.ts';
import { PersonalAgent, type Company } from '../agent/personal-agent.ts';

let net: Awaited<ReturnType<typeof startNetwork>>;
let agent: PersonalAgent;
let company: Company;

before(async () => {
  net = await startNetwork({ stageSec: 30, searchWindowMs: 300 });
  agent = await new PersonalAgent().start();
  company = await agent.discover(net.gatewayUrl);
});
after(async () => {
  await agent?.stop();
  await net?.stop();
});

test('excluded tasks: listed in poppy.json, fetched without a token, shape per 9.1 and 9.2', async () => {
  const url = company.poppy.excluded_tasks.url;
  const doc = await (await fetch(url)).json();
  assert.ok(Array.isArray(doc.tasks) && doc.tasks.length > 0);
  for (const t of doc.tasks) {
    assert.equal(typeof t.task, 'string');
    if (t.alternative) {
      assert.ok(t.alternative.instructions || t.alternative.references);
      for (const ref of t.alternative.references ?? []) {
        // 9.2: an openapi reference must name an API listed in poppy.json.
        if (ref.type === 'openapi') assert.ok(company.poppy.apis.some((a: any) => a.type === 'openapi' && a.url === ref.url));
      }
    }
  }
});

test('feedback: 202 with a Session, 400 invalid_session without one, 400 when too long', async () => {
  const endpoint = company.poppy.feedback.endpoint;
  const ok = await agent.call(company, agent.newSession(), 'POST', endpoint, { body: { task: 'Pay with a gift card', description: 'The User wanted to pay with a gift card; no interface supports it.' } });
  assert.equal(ok.status, 202);
  const anon = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'x', description: 'y' }) });
  assert.equal(anon.status, 400);
  assert.equal((await anon.json()).error, 'invalid_session');
  const long = await agent.call(company, agent.newSession(), 'POST', endpoint, { body: { task: 'x'.repeat(201), description: 'y' } });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'invalid_request');
  const logged = net.gateway.feedback();
  assert.ok(logged.some((f) => f.task === 'Pay with a gift card' && f.client_id === agent.clientId));
  assert.ok(logged.every((f) => f.client_id)); // every stored report is attributed
});

test('wait must be a whole number; foreign cursors are invalid_cursor (8.13)', async () => {
  const sid = agent.newSession();
  const start = await agent.say(company, sid, null, { text: 'namaste' });
  const id = start.body.conversation_id;
  const badWait = await agent.call(company, sid, 'GET', `/poppy/conversations/${id}/events?wait=1.5`);
  assert.equal(badWait.body.error, 'invalid_request');
  const badCursor = await agent.call(company, sid, 'GET', `/poppy/conversations/${id}/events?cursor=evt_zz_nope`);
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.error, 'invalid_cursor');
});

/** Opens an SSE stream and collects events until `until` returns true. */
function stream(url: string, headers: Record<string, string>, until: (events: any[]) => boolean): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const req = request(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          const id = block.split('\n').find((l) => l.startsWith('id: '))?.slice(4);
          if (data) {
            const e = JSON.parse(data.slice(6));
            assert.equal(e.id, id); // 8.6: the SSE id is the event ID
            events.push(e);
            if (until(events)) {
              req.destroy();
              resolve(events);
            }
          }
        }
      });
    });
    req.on('error', (e) => (events.length ? resolve(events) : reject(e)));
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error('stream timeout'));
    }, 8000);
  });
}

test('SSE: events stream live, and Last-Event-ID resumes without duplicates (8.6)', async () => {
  const sid = agent.newSession();
  const start = await agent.say(company, sid, null, { text: 'namaste' }, 0);
  const id = start.body.conversation_id;
  const url = `${net.gatewayUrl}/poppy/conversations/${id}/events`;
  const first = await stream(url, { 'poppy-session': agent.sessionJwt(company, sid, 'GET', url) }, (ev) => ev.some((e) => e.message?.role === 'company'));
  const last = first.at(-1).id;
  // Something new happens, then the agent reconnects from where it stopped.
  await agent.say(company, sid, id, { text: '1 kilo dal' }, 0);
  const resumed = await stream(url, { 'poppy-session': agent.sessionJwt(company, sid, 'GET', url), 'last-event-id': last }, (ev) => ev.some((e) => e.message?.role === 'company'));
  const seen = new Set(first.map((e) => e.id));
  assert.ok(resumed.length > 0);
  assert.ok(resumed.every((e) => !seen.has(e.id)), 'no duplicates after resume');
  assert.ok(resumed.some((e) => e.message?.text === '1 kilo dal'));
});

test('a Personal Agent whose delegations are signed with PS384 is accepted (5.2)', async () => {
  const rsaAgent = await new PersonalAgent({ ps384: true }).start();
  try {
    const c = await rsaAgent.discover(net.gatewayUrl);
    const r = await rsaAgent.call(c, rsaAgent.newSession(), 'GET', `/api/v1/search?q=atta`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    await rsaAgent.stop();
  }
});

test('an agent without the Operations extension can chat and search, but is never sent an operation', async () => {
  const legacy = await new PersonalAgent({ supportsOperations: false }).start();
  try {
    const c = await legacy.discover(net.gatewayUrl);
    const sid = legacy.newSession();
    let r = await legacy.say(c, sid, null, { text: '1 kilo atta' });
    assert.equal(r.status, 201);
    r = await legacy.say(c, sid, r.body.conversation_id, { text: 'order', data: { delivery: { name: 'A', phone: '9876543210', address: { city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } } } });
    assert.ok(r.body.events.every((e: any) => !e.message?.operation));
    assert.ok(r.body.events.some((e: any) => e.message?.data?.extension_required === 'operations'));
  } finally {
    await legacy.stop();
  }
});
