import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKV, SqliteKV, StoreFullError, type KV } from '../src/store/kv.ts';
import { ApprovalGate } from '../src/poppy/operations.ts';

const limits = { defaultMax: 3, noEvict: ['ops'] };

function suite(name: string, make: (now: () => number) => KV) {
  test(`${name}: get, set, delete, list by prefix`, () => {
    const kv = make(Date.now);
    kv.set('a', 'x:1', { n: 1 });
    kv.set('a', 'x:2', { n: 2 });
    kv.set('a', 'y:1', { n: 3 });
    assert.deepEqual(kv.get('a', 'x:1'), { n: 1 });
    assert.deepEqual(kv.list('a', 'x:').map((e) => e.key), ['x:1', 'x:2']);
    kv.delete('a', 'x:1');
    assert.equal(kv.get('a', 'x:1'), undefined);
    kv.close();
  });

  test(`${name}: entries expire`, () => {
    let now = 1_000_000;
    const kv = make(() => now);
    kv.set('a', 'k', 1, 10);
    assert.equal(kv.get('a', 'k'), 1);
    now += 11_000;
    assert.equal(kv.get('a', 'k'), undefined);
    kv.close();
  });

  test(`${name}: full namespaces evict the oldest, except no-evict ones which refuse`, () => {
    let now = 1_000_000;
    const kv = make(() => (now += 1));
    for (const k of ['1', '2', '3', '4']) kv.set('a', k, k);
    assert.equal(kv.get('a', '1'), undefined);
    assert.equal(kv.count('a'), 3);
    for (const k of ['1', '2', '3']) kv.set('ops', k, k);
    assert.throws(() => kv.set('ops', '4', '4'), StoreFullError);
    kv.set('ops', '3', 'updated'); // updating an existing key is always allowed
    assert.equal(kv.get('ops', '3'), 'updated');
    kv.close();
  });
}

suite('MemoryKV', (now) => new MemoryKV(limits, now));
const dir = mkdtempSync(join(tmpdir(), 'haat-kv-'));
let n = 0;
suite('SqliteKV', (now) => new SqliteKV(join(dir, `t${n++}.db`), limits, now));

test('SqliteKV: data survives closing and reopening the file', () => {
  const file = join(dir, 'reopen.db');
  const a = new SqliteKV(file);
  a.set('orders', 'KKS-1', { total: '129.00' });
  a.close();
  const b = new SqliteKV(file);
  assert.deepEqual(b.get('orders', 'KKS-1'), { total: '129.00' });
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an operation interrupted mid-perform answers in_progress after a restart, never runs twice', async () => {
  const kv = new MemoryKV();
  let performed = 0;
  const req = (approval: { operation_id: string; revision: string } | null) => ({
    ownerKey: 's', actionKey: 'order', fingerprint: 'f', approval,
    quote: async () => ({ summary: 'Buy', ttlSec: 600, context: {} }),
    perform: () => new Promise<{ status: number; body: unknown }>(() => { performed++; }), // never settles: the "crash"
  });
  const g1 = new ApprovalGate<object>({ kv, performTimeoutMs: 20 });
  const op = ((await g1.handle(req(null))) as { operation: { operation_id: string; revision: string } }).operation;
  assert.equal((await g1.handle(req(op))).kind, 'in_progress');
  // "Restart": a new gate on the same storage, with no memory of the in-flight call.
  const g2 = new ApprovalGate<object>({ kv, performTimeoutMs: 20 });
  assert.equal((await g2.handle(req(op))).kind, 'in_progress');
  assert.equal((await g2.handle(req(null))).kind, 'in_progress');
  assert.equal(performed, 1);
});
