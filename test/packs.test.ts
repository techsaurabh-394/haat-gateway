import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadPacks, validatePack, PackError } from '../src/commerce/packs.ts';

test('every pack in packs/ loads and validates', () => {
  const packs = loadPacks(join(import.meta.dirname, '..', 'packs'));
  assert.ok(packs.length >= 2);
  for (const p of packs) {
    assert.match(p.domain, /^ONDC:[A-Z]{3}\d{2}$/);
    assert.ok(p.lexicon.entries.length > 0, p.id);
  }
});

test('a variant claimed by two products is rejected', () => {
  const pack = { id: 'x', name: 'x', domain: 'ONDC:RET10', description: 'x', quote_ttl_sec: 60, maintainers: [] };
  const lex = { version: 1, entries: [{ term: 'milk', variants: ['doodh'] }, { term: 'curd', variants: ['Doodh'] }] };
  assert.throws(() => validatePack(pack, lex, 'test'), PackError);
});

test('bad domain codes and missing fields are rejected', () => {
  const lex = { version: 1, entries: [{ term: 'a', variants: ['a'] }] };
  assert.throws(() => validatePack({ id: 'x', name: 'x', domain: 'grocery', description: 'x', quote_ttl_sec: 60, maintainers: [] }, lex, 't'), /domain/);
  assert.throws(() => validatePack({ id: 'x', name: 'x', domain: 'ONDC:RET10', quote_ttl_sec: 60, maintainers: [] }, lex, 't'), /description/);
  assert.throws(() => validatePack({ id: 'x', name: 'x', domain: 'ONDC:RET10', description: 'x', quote_ttl_sec: 60, maintainers: [] }, { version: 1, entries: [{ term: 'a', variants: [] }] }, 't'), /variants/);
});
