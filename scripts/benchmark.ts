/**
 * Measures the language parser against dataset/benchmark-phrases.json.
 * Run: npm run benchmark            prints the table
 *      npm run benchmark -- --md    also writes docs/benchmark.md
 *      npm run benchmark -- --fail  list every wrong phrase
 *
 * A phrase is "exact" when the parser returns exactly the expected terms (in order) with the
 * expected quantities. Term accuracy ignores quantities; quantity accuracy is over expected items.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPacks } from '../src/commerce/packs.ts';
import { Lexicon } from '../src/lexicon/normalize.ts';

type Phrase = { lang: string; text: string; expect: { term: string; quantity: string | null }[] };

const root = join(import.meta.dirname, '..');
const phrases = JSON.parse(readFileSync(join(root, 'dataset/benchmark-phrases.json'), 'utf8')) as Phrase[];
const pack = loadPacks(join(root, 'packs')).find((p) => p.domain === 'ONDC:RET10')!;
const lexicon = new Lexicon([pack.lexicon]);

type Stat = { phrases: number; exact: number; termsExpected: number; termsRight: number; qtyExpected: number; qtyRight: number };
const stats = new Map<string, Stat>();
const wrong: string[] = [];
const get = (k: string): Stat => {
  let s = stats.get(k);
  if (!s) stats.set(k, (s = { phrases: 0, exact: 0, termsExpected: 0, termsRight: 0, qtyExpected: 0, qtyRight: 0 }));
  return s;
};

for (const p of phrases) {
  const got = lexicon.parse(p.text).map((t) => ({ term: t.term, quantity: t.quantity ? `${t.quantity.value}${t.quantity.unit}` : null }));
  let exact = got.length === p.expect.length;
  for (const key of [p.lang, 'ALL']) {
    const s = get(key);
    s.phrases++;
    for (const e of p.expect) {
      s.termsExpected++;
      const g = got.find((x) => x.term === e.term);
      if (g) s.termsRight++;
      if (e.quantity) {
        s.qtyExpected++;
        if (g?.quantity === e.quantity) s.qtyRight++;
      }
    }
  }
  for (let i = 0; i < p.expect.length; i++) if (got[i]?.term !== p.expect[i]!.term || got[i]?.quantity !== p.expect[i]!.quantity) exact = false;
  for (const key of [p.lang, 'ALL']) if (exact) get(key).exact++;
  if (!exact) wrong.push(`[${p.lang}] ${p.text}\n    expected ${JSON.stringify(p.expect.map((e) => `${e.term}${e.quantity ? ' ' + e.quantity : ''}`))}\n    got      ${JSON.stringify(got.map((g) => `${g.term}${g.quantity ? ' ' + g.quantity : ''}`))}`);
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const keys = [...stats.keys()].filter((k) => k !== 'ALL').sort((a, b) => stats.get(b)!.phrases - stats.get(a)!.phrases);
const rows = [...keys, 'ALL'].map((k) => {
  const s = stats.get(k)!;
  return `| ${k} | ${s.phrases} | ${pct(s.exact, s.phrases)} | ${pct(s.termsRight, s.termsExpected)} | ${pct(s.qtyRight, s.qtyExpected)} |`;
});
const table = ['| Language / script | Phrases | Exact phrase | Item found | Quantity right |', '| --- | ---: | ---: | ---: | ---: |', ...rows].join('\n');
console.log(table);
if (process.argv.includes('--fail')) console.log(`\n${wrong.length} wrong:\n${wrong.join('\n')}`);

if (process.argv.includes('--md')) {
  const all = stats.get('ALL')!;
  const md = `# Language parser benchmark

Measured by \`npm run benchmark\` on ${all.phrases} phrases in \`dataset/benchmark-phrases.json\`
against the ONDC grocery pack. **Read the caveats before quoting a number.**

${table}

- **Exact phrase**: every item and quantity in the phrase is right, in order.
- **Item found**: the expected product term was returned (quantities ignored).
- **Quantity right**: the expected amount and unit were returned, over items that have a quantity.

## Caveats (please quote them with the numbers)

- The phrases were **written by the maintainer's tooling from the lexicon's vocabulary and common
  shopping patterns, not collected from real customers**. They are therefore easier than real
  messages: no typos beyond spelling variants, little mixed-language slang, no voice-to-text noise.
  Treat the accuracy as an upper bound.
- The expected answers were **not reviewed by native speakers**, except where noted by contributors
  in \`dataset/reviews.json\`. Hinglish is ${pct(stats.get('hinglish')!.phrases, all.phrases)} of the set; other languages have only 5 to 20 phrases each,
  so their per-language numbers are rough.
- Product names come from the same lexicon the parser uses, so this measures consistency and
  quantity handling more than coverage of words people actually type.
- It says nothing about ONDC sellers, search results or ordering.
- **History, stated openly:** the first run scored 92.7% exact on 205 phrases. Before publishing, 6
  expected answers were corrected (a "bottle" or "gaddi" counts as one unit, which the parser was
  right about) and one ill-formed phrase ("1 litre chai patti", tea is not sold by the litre) was
  removed, giving the numbers above. The remaining misses are real parser gaps: two adjacent
  products with no separator ("pyaz tamatar aloo", "adrak lahsun"), brand and slang words not in
  the lexicon ("maggi", "chaach", "thanda"), "garam masala" read as "masala", "ragi atta" read as
  wheat flour, and one Kannada spelling of tomato. Run \`npm run benchmark -- --fail\` to list them.

## Help make it real

Add real phrases (with the language and what you meant) through a pull request to
\`dataset/benchmark-phrases.json\`. Phrases from real people are worth more than any number here.
`;
  writeFileSync(join(root, 'docs/benchmark.md'), md);
  console.log('wrote docs/benchmark.md');
}
