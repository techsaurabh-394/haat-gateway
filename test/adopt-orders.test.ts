/** Regression: adopting guest orders must not leave the old guest index entry reading back as the guest's. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Commerce, CommerceError } from '../src/commerce/service.ts';

function service() {
  return new Commerce({ bap: {} as never, registry: {} as never, packs: [] });
}

function stored(userKey: string, id: string) {
  return {
    id,
    userKey,
    bppId: 'seller.example',
    bppUri: 'https://seller.example',
    transactionId: 't1',
    providerName: 'Shop',
    order: { id },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as never;
}

test('adoptOrders moves orders to the account and leaves nothing behind for the guest key', () => {
  const s = service();
  s.saveOrder(stored('guest-1', 'o1'));
  s.adoptOrders('guest-1', 'acct-1');

  assert.deepEqual(s.ordersOf('acct-1').map((o) => o.id), ['o1']);
  assert.deepEqual(s.ordersOf('guest-1'), []);
  assert.equal(s.owned('o1', 'acct-1').id, 'o1');
  assert.throws(() => s.owned('o1', 'guest-1'), CommerceError);
});

test('ordersOf never returns an order owned by someone else, even with a stale index entry', () => {
  const s = service();
  s.saveOrder(stored('guest-1', 'o1'));
  // Simulate the old behaviour: re-save under the account without removing the guest index entry.
  s.saveOrder({ ...(s.owned('o1', 'guest-1')), userKey: 'acct-1' });

  assert.deepEqual(s.ordersOf('guest-1'), []);
  assert.deepEqual(s.ordersOf('acct-1').map((o) => o.id), ['o1']);
});
