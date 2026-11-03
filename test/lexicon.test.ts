import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadPacks } from '../src/commerce/packs.ts';
import { Lexicon, phoneticKey, normalizeText, measureToBase } from '../src/lexicon/normalize.ts';

const packs = loadPacks(join(import.meta.dirname, '..', 'packs'));
const grocery = new Lexicon([packs.find((p) => p.domain === 'ONDC:RET10')!.lexicon]);
const terms = (q: string) => grocery.parse(q).map((t) => [t.term, t.quantity ? `${t.quantity.value}${t.quantity.unit}` : '-']);

test('Hinglish list with digits and units', () => {
  assert.deepEqual(terms('2 kilo atta aur 1 litre doodh'), [['wheat flour', '2000g'], ['milk', '1000ml']]);
});

test('Hindi number words, and "do" as a number vs "do" as "give"', () => {
  assert.deepEqual(terms('do kilo aata de do'), [['wheat flour', '2000g']]);
  assert.deepEqual(terms('mujhe aadha kilo paneer chahiye'), [['paneer', '500g']]);
  assert.deepEqual(terms('dedh litre doodh'), [['milk', '1500ml']]);
});

test('Devanagari script, Devanagari digits and the danda', () => {
  assert.deepEqual(terms('मुझे दो किलो आटा और एक लीटर दूध चाहिए।'), [['wheat flour', '2000g'], ['milk', '1000ml']]);
  assert.deepEqual(terms('२ किलो चीनी'), [['sugar', '2000g']]);
});

test('spelling variants meet through the phonetic key', () => {
  for (const v of ['doodh', 'dudh', 'dood', 'doodhh', 'Doodh']) assert.equal(grocery.parse(v)[0]!.term, 'milk', v);
  for (const v of ['atta', 'aata', 'aataa', 'ATTA']) assert.equal(grocery.parse(v)[0]!.term, 'wheat flour', v);
  for (const v of ['pyaz', 'pyaaz', 'pyaj']) assert.equal(grocery.parse(v)[0]!.term, 'onion', v);
  assert.equal(phoneticKey('cheeni'), phoneticKey('chini'));
});

test('multi-word variants beat their single-word parts', () => {
  assert.equal(grocery.parse('1 litre sarson ka tel')[0]!.term, 'mustard oil');
  assert.equal(grocery.parse('1 litre tel')[0]!.term, 'cooking oil');
});

test('packets, dozens and bare counts', () => {
  assert.deepEqual(terms('2 packet namak'), [['salt', '2unit']]);
  assert.deepEqual(terms('1 dozen ande'), [['eggs', '12unit']]);
  assert.deepEqual(terms('500g besan, 2kg chawal'), [['gram flour', '500g'], ['rice', '2000g']]);
});

test('unknown products are kept as raw search terms, not dropped', () => {
  const t = grocery.parse('2 kilo dragon fruit')[0]!;
  assert.equal(t.matched, false);
  assert.equal(t.term, 'dragon fruit');
  assert.deepEqual(t.quantity, { value: 2000, unit: 'g' });
});

test('regression: makhana (fox nuts) must not match makhan (butter)', () => {
  assert.notEqual(phoneticKey('makhana'), phoneticKey('makhan'));
  assert.equal(grocery.parse('makhan')[0]!.term, 'butter');
  assert.equal(grocery.parse('makhana')[0]!.term, 'makhana');
  assert.equal(grocery.parse('मखाना')[0]!.term, 'makhana');
});

test('nukta is ignored when comparing Devanagari', () => {
  assert.equal(normalizeText('ड़'), normalizeText('ड'));
});

test('ONDC measures convert to base units', () => {
  assert.deepEqual(measureToBase({ unit: 'kilogram', value: '5' }), { value: 5000, unit: 'g' });
  assert.deepEqual(measureToBase({ unit: 'millilitre', value: '500' }), { value: 500, unit: 'ml' });
  assert.deepEqual(measureToBase({ unit: 'litre', value: '1' }), { value: 1000, unit: 'ml' });
  assert.equal(measureToBase({ unit: 'kilogram', value: 'abc' }), undefined);
});

// ---- Indian languages. The non-Hindi data is machine-drafted (docs/lexicon.md); these tests pin the
// behaviour of the parser on it, they do not certify the vocabulary as correct native usage.

const LANGUAGES: Array<[string, string, Array<[string, string]>]> = [
  ['Bhojpuri', 'bho', [['दू किलो चावल आ एक लीटर दूध', 'rice:2000g,milk:1000ml'], ['humke dhai kilo chaur aur adha litre dudh chahi', 'rice:2500g,milk:500ml']]],
  ['Marathi', 'mr', [['मला दोन किलो तांदूळ आणि अर्धा लिटर दूध पाहिजे', 'rice:2000g,milk:500ml'], ['mala don kilo tandul ani ek litre doodh pahije', 'rice:2000g,milk:1000ml']]],
  ['Bengali', 'bn', [['আমাকে দুই কেজি চাল এবং এক লিটার দুধ লাগবে', 'rice:2000g,milk:1000ml'], ['amake dui kejhi chal ar ek litre dudh lagbe', 'rice:2000g,milk:1000ml']]],
  ['Tamil', 'ta', [['எனக்கு இரண்டு கிலோ அரிசி மற்றும் அரை லிட்டர் பால் வேண்டும்', 'rice:2000g,milk:500ml'], ['enakku irandu kilo arisi mattrum arai litre paal venum', 'rice:2000g,milk:500ml']]],
  ['Telugu', 'te', [['నాకు రెండు కిలో బియ్యం మరియు ఒక లీటర్ పాలు కావాలి', 'rice:2000g,milk:1000ml'], ['naaku rendu kilo biyyam mariyu oka litre paalu kavali', 'rice:2000g,milk:1000ml']]],
  ['Gujarati', 'gu', [['મને બે કિલો ચોખા અને એક લિટર દૂધ જોઈએ', 'rice:2000g,milk:1000ml'], ['mane be kilo chokha ane ek litre dudh joiye', 'rice:2000g,milk:1000ml']]],
  ['Kannada', 'kn', [['ನನಗೆ ಎರಡು ಕಿಲೋ ಅಕ್ಕಿ ಮತ್ತು ಒಂದು ಲೀಟರ್ ಹಾಲು ಬೇಕು', 'rice:2000g,milk:1000ml'], ['nanage eradu kilo akki mattu ondu litre haalu beku', 'rice:2000g,milk:1000ml']]],
  ['Malayalam', 'ml', [['എനിക്ക് രണ്ട് കിലോ അരി പിന്നെ ഒരു ലിറ്റർ പാൽ വേണം', 'rice:2000g,milk:1000ml'], ['enikku randu kilo ari pinne onnara litre paal venam', 'rice:2000g,milk:1500ml']]],
  ['Punjabi', 'pa', [['ਮੈਨੂੰ ਦੋ ਕਿਲੋ ਚੌਲ ਅਤੇ ਇੱਕ ਲੀਟਰ ਦੁੱਧ ਚਾਹੀਦਾ', 'rice:2000g,milk:1000ml'], ['mainu do kilo chaul ate dhai litre dudh chahida', 'rice:2000g,milk:2500ml']]],
  ['Odia', 'or', [['ମୋତେ ଦୁଇ କିଲୋ ଚାଉଳ ଏବଂ ଏକ ଲିଟର ଦୁଧ ଦିଅ', 'rice:2000g,milk:1000ml'], ['mote dui kilo chaula ebam aadha litre dudha dia', 'rice:2000g,milk:500ml']]],
];
const flat = (q: string) => grocery.parse(q).map((t) => `${t.term}${t.quantity ? `:${t.quantity.value}${t.quantity.unit}` : ''}`).join(',');

for (const [name, code, cases] of LANGUAGES) {
  test(`${name}: a two-item list in native script and in Latin letters, with number words, units and "and"`, () => {
    for (const [q, want] of cases) assert.equal(flat(q), want, q);
  });
  test(`${name}: the language code is declared in the lexicon`, () => {
    const langs = lexiconFile().languages as string[];
    assert.ok(langs.includes(code) && langs.includes(`${code}-Latn`), code);
  });
}

function lexiconFile() {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'packs', 'ondc-ret10-grocery', 'lexicon.json'), 'utf8'));
}

test('digits of every Indian script become ASCII digits', () => {
  const cases: Array<[string, string]> = [
    ['२ किलो कांदा', 'onion:2000g'], ['১ কেজি আলু', 'potato:1000g'], ['௨ கிலோ தக்காளி', 'tomato:2000g'],
    ['౩ కిలో టమాటా', 'tomato:3000g'], ['૨ કિલો ડુંગળી', 'onion:2000g'], ['೨ ಕಿಲೋ ಈರುಳ್ಳಿ', 'onion:2000g'],
    ['൨ കിലോ തക്കാളി', 'tomato:2000g'], ['੨ ਕਿਲੋ ਆਲੂ', 'potato:2000g'], ['୨ କିଲୋ ଆଳୁ', 'potato:2000g'],
  ];
  for (const [q, want] of cases) assert.equal(flat(q), want, q);
});

test('a digit glued to a Tamil unit is split: 2கிலோ அரிசி', () => {
  assert.equal(flat('2கிலோ அரிசி'), 'rice:2000g');
});

test('half, one-and-a-half and two-and-a-half, in several languages', () => {
  assert.equal(flat('aadha kilo paneer'), 'paneer:500g');
  assert.equal(flat('dedh kilo chini'), 'sugar:1500g');
  assert.equal(flat('અડધો કિલો ખાંડ'), 'sugar:500g');
  assert.equal(flat('onnara litre paal'), 'milk:1500ml');
  assert.equal(flat('irandarai kilo arisi'), 'rice:2500g');
  assert.equal(flat('আড়াই কিলো চাল'), 'rice:2500g');
});

test('dozen words in other languages', () => {
  assert.equal(flat('২ ডজন কলা'), 'banana:24unit');
  assert.equal(flat('1 டஜன் முட்டை'), 'eggs:12unit');
});

test('multi-word variants beat single-word ones in other languages', () => {
  assert.equal(flat('1 litre thengai ennai'), 'coconut oil:1000ml'); // not coconut (thengai) or cooking oil (ennai)
  assert.equal(flat('1 litre ennai'), 'cooking oil:1000ml');
  assert.equal(flat('thuvaram paruppu'), 'toor dal');
  assert.equal(flat('paruppu'), 'dal');
  assert.equal(flat('ਸਰ੍ਹੋਂ ਦਾ ਤੇਲ'), 'mustard oil');
  assert.equal(flat('सरसों का तेल'), 'mustard oil');
  assert.equal(flat('தேங்காய் எண்ணெய்'), 'coconut oil');
  assert.equal(flat('kadalai paruppu'), 'chana dal');
});

test('look-alike products stay apart', () => {
  assert.equal(flat('makhan'), 'butter');
  assert.equal(flat('makhana'), 'makhana');
  assert.equal(flat('til'), 'sesame seeds');
  assert.equal(flat('tel'), 'cooking oil');
  assert.equal(flat('besan'), 'gram flour');
  assert.equal(flat('beans'), 'french beans');
  assert.equal(flat('chana'), 'chickpeas');
  assert.equal(flat('chana dal'), 'chana dal');
  assert.equal(flat('gur'), 'jaggery');
  // Known limitation: the phonetic key drops the "h" of "gh", so the Latin spelling "ghol" (Bengali buttermilk)
  // sounds like "gul" (Marathi jaggery). Buttermilk is therefore only listed in Bengali script. See docs/lexicon.md.
  assert.equal(flat('ghol'), 'jaggery');
  assert.equal(flat('ঘোল'), 'buttermilk');
});

test('"chai" is tea, not a Bengali "want"', () => {
  assert.equal(flat('1 kg chai'), 'tea:1000g');
  assert.equal(flat('amake lagbe doi'), 'curd');
});

test('Malayalam chillu letters match in either spelling', () => {
  assert.equal(normalizeText('\u0d7b'), normalizeText('\u0d28\u0d4d'));
  assert.equal(flat('പാൽ'), 'milk');
  assert.equal(flat('\u0d2a\u0d3e\u0d32\u0d4d'), 'milk');
});

test('zero-width joiners do not change a match', () => {
  assert.equal(flat('പാ\u200dൽ'), 'milk');
});

test('the lexicon has 100+ products and no variant is claimed by two products (exact or phonetic)', () => {
  const lx = lexiconFile() as { entries: Array<{ term: string; variants: string[] }>; stopwords: string[] };
  assert.ok(lx.entries.length >= 100, `only ${lx.entries.length} products`);
  const terms = new Set<string>();
  const exact = new Map<string, string>();
  const keyed = new Map<string, string>();
  const stop = new Set(lx.stopwords.map(normalizeText));
  const keyOf = (v: string) => {
    const w = normalizeText(v).replace(/[^\p{L}\p{M}\d ]/gu, ' ').split(/\s+/).filter(Boolean);
    const c = w.filter((x) => !stop.has(x));
    return (c.length ? c : w).map(phoneticKey).join(' ');
  };
  for (const e of lx.entries) {
    assert.ok(!terms.has(e.term), `duplicate product ${e.term}`);
    terms.add(e.term);
    for (const v of [...e.variants, e.term]) {
      const x = normalizeText(v);
      assert.ok(!exact.has(x) || exact.get(x) === e.term, `"${v}" is claimed by both ${exact.get(x)} and ${e.term}`);
      exact.set(x, e.term);
      const k = keyOf(v);
      assert.ok(k.length > 0, `"${v}" (${e.term}) normalises to nothing`);
      assert.ok(!keyed.has(k) || keyed.get(k) === e.term, `"${v}" sounds the same as a variant of ${keyed.get(k)} (not ${e.term})`);
      keyed.set(k, e.term);
    }
  }
});

test('no product word is also a number, unit, stopword or separator', () => {
  const lx = lexiconFile() as { entries: Array<{ term: string; variants: string[] }>; stopwords: string[]; separators: string[]; numbers: Record<string, number>; units: Record<string, string> };
  const reserved = new Map<string, string>();
  for (const w of lx.stopwords) reserved.set(normalizeText(w), 'stopword');
  for (const w of lx.separators) reserved.set(normalizeText(w), 'separator');
  for (const w of Object.keys(lx.numbers)) reserved.set(normalizeText(w), 'number');
  for (const w of Object.keys(lx.units)) reserved.set(normalizeText(w), 'unit');
  for (const e of lx.entries) for (const v of e.variants) {
    const w = normalizeText(v);
    // Known, deliberate overlaps are listed here with the reason; anything new fails the test.
    assert.ok(!reserved.has(w) || ALLOWED_OVERLAP.has(w), `"${v}" (${e.term}) is also a ${reserved.get(w)}`);
  }
});
const ALLOWED_OVERLAP = new Set<string>();

test('every ONDC grocery term in the mock sellers exists in the lexicon', () => {
  const lx = lexiconFile() as { entries: Array<{ term: string }> };
  const known = new Set(lx.entries.map((e) => e.term));
  for (const f of ['assi-sabzi', 'ganga-dairy', 'kashi-kirana']) {
    const d = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'mock-network', 'sellers', `${f}.json`), 'utf8')) as { items: Array<{ id: string; terms: string[] }> };
    for (const i of d.items) for (const t of i.terms) assert.ok(known.has(t), `${i.id}: unknown term ${t}`);
  }
});
