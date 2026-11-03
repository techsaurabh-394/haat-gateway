import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStore, parseWait, validateIncomingMessage } from '../src/poppy/conversations.ts';
import { MemoryKV } from '../src/store/kv.ts';
import { HttpError } from '../src/util/http.ts';

const msg = (id: string, text = 'hi') => validateIncomingMessage({ id, author: { type: 'agent' }, text });

test('message validation: IDs, author type, content, and role is ignored', () => {
  assert.throws(() => validateIncomingMessage({ id: 'bad id!', author: { type: 'agent' }, text: 'x' }), HttpError);
  assert.throws(() => validateIncomingMessage({ id: 'm1', author: { type: 'robot' }, text: 'x' }), HttpError);
  assert.throws(() => validateIncomingMessage({ id: 'm1', author: { type: 'agent' } }), HttpError);
  const m = validateIncomingMessage({ id: 'm1', author: { type: 'human' }, text: 'x', role: 'company', extra: 1 });
  assert.equal(m.role, undefined);
  assert.equal((m as Record<string, unknown>).extra, undefined);
});

test('retrying a message ID with the same content replays; different content conflicts', () => {
  const s = new ConversationStore();
  const c = s.create('owner');
  const m = msg('m1');
  s.remember('owner', m, c.id, { status: 202, body: { conversation_id: c.id } });
  assert.deepEqual(s.replay('owner', msg('m1')), { status: 202, body: { conversation_id: c.id } });
  assert.throws(() => s.replay('owner', msg('m1', 'changed')), (e: unknown) => e instanceof HttpError && e.body.error === 'message_id_conflict');
  assert.equal(s.replay('someone-else', msg('m1')), null);
});

test('other owners cannot read a conversation', () => {
  const s = new ConversationStore();
  const c = s.create('owner');
  assert.throws(() => s.get(c.id, 'intruder'), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test('cursors return only newer events; foreign cursors are invalid_cursor (8.13)', async () => {
  const s = new ConversationStore();
  const c = s.create('o');
  s.addMessage(c, 'user', msg('m1'));
  s.companyMessage(c, { text: 'hello' });
  const all = (await s.read(c, undefined, 0)) as { events: Array<{ id: string }>; cursor: string };
  assert.equal(all.events.length, 2);
  const none = (await s.read(c, all.cursor, 0)) as { events: unknown[]; cursor: string; status: string; responder: string };
  assert.equal(none.events.length, 0);
  assert.equal(none.cursor, all.cursor);
  assert.equal(none.responder, 'agent');
  await assert.rejects(s.read(c, 'evt_unknown', 0), (e: unknown) => e instanceof HttpError && e.status === 400 && e.body.error === 'invalid_cursor');
  const other = s.create('o');
  s.addMessage(other, 'user', msg('m9'));
  const foreign = ((await s.read(other, undefined, 0)) as { cursor: string }).cursor;
  await assert.rejects(s.read(c, foreign, 0), (e: unknown) => e instanceof HttpError && e.body.error === 'invalid_cursor');
});

test('dropped events make their cursors expire (410 cursor_expired)', async () => {
  const s = new ConversationStore(undefined, { maxEvents: 3 });
  const c = s.create('o');
  s.addMessage(c, 'user', msg('m1'));
  const first = ((await s.read(c, undefined, 0)) as { cursor: string }).cursor;
  for (let i = 2; i <= 6; i++) s.addMessage(c, 'user', msg(`m${i}`));
  assert.equal(c.events.length, 3);
  await assert.rejects(s.read(c, first, 0), (e: unknown) => e instanceof HttpError && e.status === 410 && e.body.error === 'cursor_expired');
  const fresh = (await s.read(c, undefined, 0)) as { events: unknown[] };
  assert.equal(fresh.events.length, 3);
});

test('conversations survive in storage when evicted from memory', () => {
  const kv = new MemoryKV();
  const s = new ConversationStore(kv, { maxLive: 1 });
  const a = s.create('o');
  s.addMessage(a, 'user', msg('m1'));
  s.create('o'); // evicts a from the live set
  assert.equal(s.live.has(a.id), false);
  const back = s.get(a.id, 'o');
  assert.equal(back.events.length, 1);
});

test('wait must be a whole number of seconds', () => {
  assert.equal(parseWait(null), 0);
  assert.equal(parseWait('10'), 10);
  for (const bad of ['-1', '1.5', 'abc', '1e3']) assert.throws(() => parseWait(bad), (e: unknown) => e instanceof HttpError && e.body.error === 'invalid_request', bad);
});

test('long polling wakes up when an event arrives', async () => {
  const s = new ConversationStore();
  const c = s.create('o');
  s.addMessage(c, 'user', msg('m1'));
  const first = (await s.read(c, undefined, 0)) as { cursor: string };
  const started = Date.now();
  const pending = s.read(c, first.cursor, 5);
  setTimeout(() => s.companyMessage(c, { text: 'reply' }), 50);
  const r = (await pending) as { events: Array<{ message: { text: string; role: string } }> };
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.events[0]!.message.text, 'reply');
  assert.equal(r.events[0]!.message.role, 'company');
});

test('state changes are events; closing twice adds nothing', async () => {
  const s = new ConversationStore();
  const c = s.create('o');
  s.setState(c, 'idle');
  s.close(c);
  s.close(c);
  const r = (await s.read(c, undefined, 0)) as { events: Array<{ type: string; status?: string }>; status: string };
  assert.deepEqual(r.events.map((e) => e.status), ['idle', 'closed']);
  assert.equal(r.status, 'closed');
});
