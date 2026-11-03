/**
 * Builds a single-seller basket from a parsed shopping list.
 *
 * An ONDC order goes to one provider, so the basket picks the provider that covers the most
 * items, then the cheapest. Within a provider, each item gets the pack size and count that waste
 * the least ("2 kg atta" with 1 kg and 5 kg packs -> 2 x 1 kg).
 */
import { measureToBase, type Quantity, type Term } from '../lexicon/normalize.ts';

export type Offer = {
  bppId: string;
  bppUri: string;
  providerId: string;
  providerName: string;
  locality?: string;
  itemId: string;
  name: string;
  price: number; // INR per unit sold
  measure?: Quantity; // pack size in base units
  available: number;
  term: string; // which search term found it
};

export type BasketLine = { term: string; raw: string; offer: Offer; count: number; lineTotal: number; fit: string };

export type Basket = {
  bppId: string;
  bppUri: string;
  providerId: string;
  providerName: string;
  locality?: string;
  lines: BasketLine[];
  missing: Array<{ term: string; raw: string; reason: string }>;
  itemsTotal: number;
};

function chooseCount(want: Quantity | undefined, offer: Offer): { count: number; waste: number } | null {
  if (!want) return { count: 1, waste: 0 };
  const pack = offer.measure;
  if (want.unit === 'unit') {
    // "12 ande" with egg trays of 6 and 12 means 12 eggs; "2 sabun" with a pack of 4 means 2 packs.
    if (pack?.unit === 'unit' && pack.value > 1 && want.value >= pack.value) {
      const count = Math.ceil(want.value / pack.value - 1e-9);
      return { count, waste: count * pack.value - want.value };
    }
    return { count: Math.max(1, Math.round(want.value)), waste: 0 };
  }
  if (!pack || pack.unit !== want.unit) return null; // cannot compare grams with litres
  const count = Math.max(1, Math.ceil(want.value / pack.value - 1e-9));
  return { count, waste: count * pack.value - want.value };
}

export function buildBasket(terms: Term[], offers: Offer[]): Basket | null {
  const byProvider = new Map<string, Offer[]>();
  for (const o of offers) {
    const k = `${o.bppId}|${o.providerId}`;
    if (!byProvider.has(k)) byProvider.set(k, []);
    byProvider.get(k)!.push(o);
  }
  let best: Basket | null = null;
  for (const providerOffers of byProvider.values()) {
    const first = providerOffers[0]!;
    const lines: BasketLine[] = [];
    const missing: Basket['missing'] = [];
    for (const t of terms) {
      const candidates = providerOffers
        .filter((o) => o.term === t.term && o.available > 0)
        .map((o) => ({ o, c: chooseCount(t.quantity, o) }))
        .filter((x): x is { o: Offer; c: { count: number; waste: number } } => x.c !== null && x.c.count <= x.o.available)
        .sort((a, b) => a.c.waste - b.c.waste || a.c.count * a.o.price - b.c.count * b.o.price);
      const pick = candidates[0];
      if (!pick) {
        missing.push({ term: t.term, raw: t.raw, reason: providerOffers.some((o) => o.term === t.term) ? 'not enough stock or pack size' : 'not sold here' });
        continue;
      }
      lines.push({
        term: t.term,
        raw: t.raw,
        offer: pick.o,
        count: pick.c.count,
        lineTotal: round2(pick.c.count * pick.o.price),
        fit: pick.c.waste > 0 ? 'rounded up to the nearest pack' : 'exact',
      });
    }
    if (lines.length === 0) continue;
    const basket: Basket = {
      bppId: first.bppId,
      bppUri: first.bppUri,
      providerId: first.providerId,
      providerName: first.providerName,
      locality: first.locality,
      lines,
      missing,
      itemsTotal: round2(lines.reduce((s, l) => s + l.lineTotal, 0)),
    };
    if (!best || basket.lines.length > best.lines.length || (basket.lines.length === best.lines.length && basket.itemsTotal < best.itemsTotal)) {
      best = basket;
    }
  }
  return best;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { measureToBase };
