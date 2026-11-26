/**
 * Builds a single-seller basket from a parsed shopping list.
 *
 * An ONDC order goes to one provider, so the basket picks the provider that covers the most
 * items, then the cheapest. Within a provider, each item gets the pack size and count that waste
 * the least ("2 kg atta" with 1 kg and 5 kg packs -> 2 x 1 kg).
 *
 * `why` records the comparison that was actually made, so "Why this seller?" can be answered
 * without inventing reasons. Only two things are compared: how many of the wanted items a seller
 * covers, then the items total. Delivery fee, distance, delivery time and seller reliability are
 * NOT compared, and `why.not_compared` says so.
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
  why?: Why;
};

export type WhyReason =
  | 'only_seller' // only one seller had any of the wanted items
  | 'covers_most' // covers strictly more of the list than every other seller
  | 'cheapest_among_equal' // same coverage as others, lowest items total
  | 'same_total_first_answer'; // same coverage and the same total as another seller; the first to answer won

export type WhyAlternative = {
  provider_name: string;
  covered: number;
  items_total: number;
  /** How this seller compared with the chosen one. */
  versus: 'covers_less' | 'costs_more' | 'cheaper_but_covers_less' | 'same_total';
};

export type Why = {
  reason: WhyReason;
  covered: number;
  wanted: number;
  sellers_compared: number;
  /** Up to 3 other sellers that had at least one wanted item, best first. */
  alternatives: WhyAlternative[];
  /** What this choice does not take into account. Always present. */
  not_compared: string[];
};

export const NOT_COMPARED = ['delivery fee', 'distance', 'delivery time', 'seller reliability'];

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
  const all: Basket[] = [];
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
    all.push({
      bppId: first.bppId,
      bppUri: first.bppUri,
      providerId: first.providerId,
      providerName: first.providerName,
      locality: first.locality,
      lines,
      missing,
      itemsTotal: round2(lines.reduce((s, l) => s + l.lineTotal, 0)),
    });
  }
  let best: Basket | null = null;
  for (const basket of all) {
    if (!best || basket.lines.length > best.lines.length || (basket.lines.length === best.lines.length && basket.itemsTotal < best.itemsTotal)) {
      best = basket;
    }
  }
  if (best) best.why = explain(best, all, terms.length);
  return best;
}

function explain(best: Basket, all: Basket[], wanted: number): Why {
  const others = all.filter((o) => o !== best);
  const sameCover = others.filter((o) => o.lines.length === best.lines.length);
  let reason: WhyReason;
  if (others.length === 0) reason = 'only_seller';
  else if (sameCover.length === 0) reason = 'covers_most';
  else if (sameCover.some((o) => o.itemsTotal === best.itemsTotal)) reason = 'same_total_first_answer';
  else reason = 'cheapest_among_equal';
  const versus = (o: Basket): WhyAlternative['versus'] =>
    o.lines.length < best.lines.length ? (o.itemsTotal < best.itemsTotal ? 'cheaper_but_covers_less' : 'covers_less') : o.itemsTotal === best.itemsTotal ? 'same_total' : 'costs_more';
  const alternatives = others
    .sort((a, b) => b.lines.length - a.lines.length || a.itemsTotal - b.itemsTotal)
    .slice(0, 3)
    .map((o) => ({ provider_name: o.providerName, covered: o.lines.length, items_total: o.itemsTotal, versus: versus(o) }));
  return { reason, covered: best.lines.length, wanted, sellers_compared: all.length, alternatives, not_compared: NOT_COMPARED };
}

const inrText = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** A short, honest answer to "Why this seller?" built only from what buildBasket compared. */
export function explainWhy(b: Basket, locale?: string): string {
  const w = b.why;
  if (!w) return '';
  const hi = locale?.toLowerCase().startsWith('hi');
  const list = w.alternatives.map((a) => {
    if (hi) {
      const t = { covers_less: `${a.covered}/${w.wanted} चीज़ें`, cheaper_but_covers_less: `सस्ता (${inrText(a.items_total)}) पर सिर्फ़ ${a.covered}/${w.wanted} चीज़ें`, costs_more: `${inrText(a.items_total)}, महंगा`, same_total: `${inrText(a.items_total)}, बराबर` }[a.versus];
      return `${a.provider_name}: ${t}`;
    }
    const t = { covers_less: `${a.covered} of ${w.wanted} items`, cheaper_but_covers_less: `cheaper (${inrText(a.items_total)}) but only ${a.covered} of ${w.wanted} items`, costs_more: `${inrText(a.items_total)}, costs more`, same_total: `${inrText(a.items_total)}, same total` }[a.versus];
    return `${a.provider_name}: ${t}`;
  });
  const cover = hi ? `${w.covered}/${w.wanted} चीज़ें` : `${w.covered} of ${w.wanted} items`;
  const head = hi
    ? {
        only_seller: `सिर्फ़ ${b.providerName} के पास आपकी सूची की चीज़ें मिलीं (${cover}).`,
        covers_most: `${b.providerName} आपकी सूची की सबसे ज़्यादा चीज़ें देता है (${cover}) — ${w.sellers_compared} विक्रेताओं में से।`,
        cheapest_among_equal: `${w.sellers_compared} विक्रेताओं में ${b.providerName} और बाकी बराबर चीज़ें (${cover}) देते हैं, पर इसका सामान का कुल सबसे कम है (${inrText(b.itemsTotal)}).`,
        same_total_first_answer: `${b.providerName} और दूसरे विक्रेता की चीज़ें और कुल बराबर हैं (${cover}, ${inrText(b.itemsTotal)}); जिसने पहले जवाब दिया, वह चुना गया।`,
      }[w.reason]
    : {
        only_seller: `${b.providerName} was the only seller with items from your list (${cover}).`,
        covers_most: `${b.providerName} covers the most of your list (${cover}) among ${w.sellers_compared} sellers.`,
        cheapest_among_equal: `${w.sellers_compared} sellers cover the same ${cover}; ${b.providerName} has the lowest items total (${inrText(b.itemsTotal)}).`,
        same_total_first_answer: `${b.providerName} and another seller tie on items covered and total (${cover}, ${inrText(b.itemsTotal)}); the one that answered first was picked.`,
      }[w.reason];
  const other = list.length ? (hi ? `\nदूसरे: ${list.join('; ')}.` : `\nOthers: ${list.join('; ')}.`) : '';
  const caveat = hi
    ? `\nइसमें डिलीवरी शुल्क, दूरी, डिलीवरी समय और विक्रेता की विश्वसनीयता नहीं देखी गई।`
    : `\nNot considered: ${w.not_compared.join(', ')}.`;
  return head + other + caveat;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { measureToBase };
