/**
 * Exports the grocery lexicon as a plain, citable dataset: dataset/grocery-lexicon.json.
 * Run: node scripts/export-lexicon.ts
 *
 * Variants are grouped by WRITING SYSTEM (script), because the lexicon file does not record which
 * language a variant belongs to: Devanagari holds Hindi, Marathi and Bhojpuri together, and every
 * Latin-script spelling (Hinglish, Tamil in English letters, ...) sits in one "latin" group.
 * Every group starts as reviewed=false. Native speakers flip it in review/reviews.json via a pull
 * request (see CONTRIBUTING and dataset/README.md); this script reads that file on each export.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const lex = JSON.parse(readFileSync(join(root, 'packs/ondc-ret10-grocery/lexicon.json'), 'utf8')) as {
  entries: { term: string; category?: string; variants: string[] }[];
};

const SCRIPTS: [string, RegExp][] = [
  ['devanagari', /[\u0900-\u097F]/], ['bengali', /[\u0980-\u09FF]/], ['gurmukhi', /[\u0A00-\u0A7F]/],
  ['gujarati', /[\u0A80-\u0AFF]/], ['odia', /[\u0B00-\u0B7F]/], ['tamil', /[\u0B80-\u0BFF]/],
  ['telugu', /[\u0C00-\u0C7F]/], ['kannada', /[\u0C80-\u0CFF]/], ['malayalam', /[\u0D00-\u0D7F]/],
];
const LANGS: Record<string, string> = {
  latin: 'English plus every language typed in Latin letters (Hinglish, Tanglish, ...)',
  devanagari: 'Hindi, Marathi, Bhojpuri (Devanagari script)', bengali: 'Bengali', gurmukhi: 'Punjabi', gujarati: 'Gujarati',
  odia: 'Odia', tamil: 'Tamil', telugu: 'Telugu', kannada: 'Kannada', malayalam: 'Malayalam',
};

const scriptOf = (v: string) => SCRIPTS.find(([, re]) => re.test(v))?.[0] ?? 'latin';

const reviewsFile = join(root, 'dataset/reviews.json');
const reviews: Record<string, { reviewed: boolean; reviewers?: string[]; note?: string }> = existsSync(reviewsFile) ? JSON.parse(readFileSync(reviewsFile, 'utf8')) : {};

const entries = lex.entries.map((e) => {
  const variants: Record<string, string[]> = {};
  for (const v of e.variants) (variants[scriptOf(v)] ??= []).push(v);
  return { term: e.term, category: e.category ?? null, variants };
});

const counts: Record<string, number> = {};
for (const e of entries) for (const [s, vs] of Object.entries(e.variants)) counts[s] = (counts[s] ?? 0) + vs.length;

const out = {
  name: 'haat-grocery-lexicon',
  version: 1,
  licence: 'MIT',
  source: 'https://github.com/techsaurabh-394/haat-gateway/tree/main/packs/ondc-ret10-grocery',
  products: entries.length,
  groups: Object.fromEntries(Object.keys(LANGS).map((s) => [s, {
    covers: LANGS[s],
    variants: counts[s] ?? 0,
    reviewed: reviews[s]?.reviewed ?? false,
    reviewers: reviews[s]?.reviewers ?? [],
    note: reviews[s]?.note ?? 'Not reviewed by a native speaker yet.',
  }])),
  entries,
};

mkdirSync(join(root, 'dataset'), { recursive: true });
writeFileSync(join(root, 'dataset/grocery-lexicon.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`${entries.length} products, ${Object.values(counts).reduce((a, b) => a + b, 0)} variants in ${Object.keys(counts).length} script groups`);
