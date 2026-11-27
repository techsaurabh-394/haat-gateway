import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPacks } from '../src/commerce/packs.ts';
import { Lexicon } from '../src/lexicon/normalize.ts';

const root = join(import.meta.dirname, '..');

test('benchmark set is well formed and the parser stays above a floor', () => {
  const phrases = JSON.parse(readFileSync(join(root, 'dataset/benchmark-phrases.json'), 'utf8')) as { lang: string; text: string; expect: { term: string; quantity: string | null }[] }[];
  assert.ok(phrases.length >= 200);
  assert.equal(new Set(phrases.map((p) => p.text)).size, phrases.length, 'no duplicate phrases');
  const lex = new Lexicon([loadPacks(join(root, 'packs')).find((p) => p.domain === 'ONDC:RET10')!.lexicon]);
  let exact = 0;
  for (const p of phrases) {
    const got = lex.parse(p.text).map((t) => `${t.term} ${t.quantity ? `${t.quantity.value}${t.quantity.unit}` : '-'}`);
    if (JSON.stringify(got) === JSON.stringify(p.expect.map((e) => `${e.term} ${e.quantity ?? '-'}`))) exact++;
  }
  // A floor, not a target: lower it only on purpose and say why in the pull request.
  assert.ok(exact / phrases.length >= 0.9, `exact accuracy fell to ${((100 * exact) / phrases.length).toFixed(1)}%`);
});

test('lexicon dataset: every product is present, review flags are explicit', () => {
  const d = JSON.parse(readFileSync(join(root, 'dataset/grocery-lexicon.json'), 'utf8'));
  const lex = JSON.parse(readFileSync(join(root, 'packs/ondc-ret10-grocery/lexicon.json'), 'utf8'));
  assert.equal(d.entries.length, lex.entries.length);
  const total = Object.values(d.entries).reduce((n: number, e) => n + Object.values((e as { variants: Record<string, string[]> }).variants).flat().length, 0);
  assert.equal(total, lex.entries.reduce((n: number, e: { variants: string[] }) => n + e.variants.length, 0), 'no variant lost in the export');
  for (const [name, g] of Object.entries(d.groups) as [string, { reviewed: unknown }][]) assert.equal(typeof g.reviewed, 'boolean', name);
});
