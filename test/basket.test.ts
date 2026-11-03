import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBasket, type Offer } from '../src/commerce/basket.ts';
import type { Term } from '../src/lexicon/normalize.ts';

const offer = (o: Partial<Offer>): Offer => ({ bppId: 'b1', bppUri: 'x', providerId: 'p1', providerName: 'Shop 1', itemId: 'i', name: 'n', price: 10, available: 50, term: 't', ...o });
const term = (t: string, q?: Term['quantity']): Term => ({ raw: t, term: t, matched: true, ...(q ? { quantity: q } : {}) });

test('picks the pack size that wastes least', () => {
  const b = buildBasket([term('wheat flour', { value: 2000, unit: 'g' })], [
    offer({ itemId: '1kg', term: 'wheat flour', price: 55, measure: { value: 1000, unit: 'g' } }),
    offer({ itemId: '5kg', term: 'wheat flour', price: 245, measure: { value: 5000, unit: 'g' } }),
  ])!;
  assert.equal(b.lines[0]!.offer.itemId, '1kg');
  assert.equal(b.lines[0]!.count, 2);
  assert.equal(b.itemsTotal, 110);
});

test('rounds up to the nearest pack when nothing fits exactly', () => {
  const b = buildBasket([term('milk', { value: 1500, unit: 'ml' })], [offer({ itemId: '1l', term: 'milk', measure: { value: 1000, unit: 'ml' } })])!;
  assert.equal(b.lines[0]!.count, 2);
  assert.equal(b.lines[0]!.fit, 'rounded up to the nearest pack');
});

test('prefers the seller covering more items, then the cheaper one', () => {
  const offers = [
    offer({ providerId: 'A', providerName: 'A', itemId: 'a1', term: 'rice', price: 70 }),
    offer({ providerId: 'B', providerName: 'B', itemId: 'b1', term: 'rice', price: 80 }),
    offer({ providerId: 'B', providerName: 'B', itemId: 'b2', term: 'sugar', price: 40 }),
  ];
  assert.equal(buildBasket([term('rice'), term('sugar')], offers)!.providerId, 'B');
  assert.equal(buildBasket([term('rice')], offers)!.providerId, 'A');
});

test('reports missing items and out-of-stock items', () => {
  const b = buildBasket([term('rice'), term('salt', { value: 5, unit: 'unit' })], [offer({ term: 'rice' }), offer({ itemId: 's', term: 'salt', available: 2 })])!;
  assert.equal(b.lines.length, 1);
  assert.deepEqual(b.missing.map((m) => [m.term, m.reason]), [['salt', 'not enough stock or pack size']]);
});

test('never compares grams with litres', () => {
  const b = buildBasket([term('milk', { value: 1000, unit: 'g' })], [offer({ term: 'milk', measure: { value: 1000, unit: 'ml' } })]);
  assert.equal(b, null);
});

test('egg trays: 12 eggs is one tray of 12, "2 soap" is two packs', () => {
  const eggs = [offer({ itemId: 'e6', term: 'eggs', price: 48, measure: { value: 6, unit: 'unit' } }), offer({ itemId: 'e12', term: 'eggs', price: 92, measure: { value: 12, unit: 'unit' } })];
  const b = buildBasket([term('eggs', { value: 12, unit: 'unit' })], eggs)!;
  assert.deepEqual([b.lines[0]!.offer.itemId, b.lines[0]!.count], ['e12', 1]);
  const soap = buildBasket([term('soap', { value: 2, unit: 'unit' })], [offer({ term: 'soap', measure: { value: 4, unit: 'unit' } })])!;
  assert.equal(soap.lines[0]!.count, 2);
});

test('no offers means no basket', () => {
  assert.equal(buildBasket([term('rice')], []), null);
});
