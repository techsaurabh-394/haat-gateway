/**
 * Smoke test for scripts/loadtest.ts: a small run must place every order exactly once, replay
 * every retried approval to the same order, and agree with the mock sellers' own order count.
 * The script exits non-zero on any failure or mismatch, so the exit code is the check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/loadtest.ts', import.meta.url));

test('load test: 24 orders over 6 workers, none lost, none doubled, sellers agree', async () => {
  const { stdout } = await run(process.execPath, [script, '--workers', '6', '--orders', '24', '--search-window', '300', '--json'], { timeout: 60_000 });
  const r = JSON.parse(stdout);
  assert.equal(r.failures, 0, stdout);
  assert.equal(r.orders_placed, 24);
  assert.equal(r.unique_order_ids, 24, 'every order id is distinct');
  assert.equal(r.retries_replayed_same_order, 24, 'every retried approval returned the same order');
  assert.equal(r.seller_side_orders, 24, 'the mock sellers received exactly one confirm per order');
});

test('load test: the default per-client rate limiter answers 429 instead of failing silently', async () => {
  await assert.rejects(
    run(process.execPath, [script, '--workers', '4', '--orders', '60', '--search-window', '50', '--rate-limit', '10', '--json'], { timeout: 60_000 }),
    (e: { code?: number; stdout?: string }) => {
      assert.equal(e.code, 1);
      const r = JSON.parse(e.stdout ?? '{}');
      assert.ok(r.failures > 0);
      assert.equal(r.seller_side_orders, r.orders_placed, 'throttled runs still never double an order');
      return true;
    },
  );
});
