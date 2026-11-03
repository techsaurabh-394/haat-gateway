/**
 * Domain packs: one folder per ONDC domain under packs/. A pack is data, not code, so adding a
 * domain or a language is a pull request that needs no TypeScript. See docs/domain-packs.md.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LexiconFile } from '../lexicon/normalize.ts';

export type Pack = {
  id: string;
  name: string;
  domain: string;
  description: string;
  quote_ttl_sec: number;
  maintainers: string[];
  lexicon: LexiconFile;
};

export class PackError extends Error {}

export function validatePack(raw: unknown, lexicon: unknown, where: string): Pack {
  const p = raw as Record<string, unknown>;
  const need = (k: string, type: string) => {
    if (typeof p[k] !== type) throw new PackError(`${where}: "${k}" must be a ${type}`);
  };
  need('id', 'string');
  need('name', 'string');
  need('domain', 'string');
  need('description', 'string');
  need('quote_ttl_sec', 'number');
  if (!/^ONDC:[A-Z]{3}\d{2}$/.test(p.domain as string)) throw new PackError(`${where}: domain must look like ONDC:RET10`);
  if (!Array.isArray(p.maintainers)) throw new PackError(`${where}: "maintainers" must be a list of GitHub usernames`);
  const lx = lexicon as LexiconFile;
  if (!lx || !Array.isArray(lx.entries)) throw new PackError(`${where}: lexicon must have "entries"`);
  const seen = new Map<string, string>();
  for (const e of lx.entries) {
    if (typeof e.term !== 'string' || !Array.isArray(e.variants) || e.variants.length === 0) {
      throw new PackError(`${where}: every lexicon entry needs "term" and a non-empty "variants" list`);
    }
    for (const v of e.variants) {
      const key = v.toLowerCase();
      const prev = seen.get(key);
      if (prev && prev !== e.term) throw new PackError(`${where}: variant "${v}" is used by both "${prev}" and "${e.term}"`);
      seen.set(key, e.term);
    }
  }
  return {
    id: p.id as string,
    name: p.name as string,
    domain: p.domain as string,
    description: p.description as string,
    quote_ttl_sec: p.quote_ttl_sec as number,
    maintainers: p.maintainers as string[],
    lexicon: lx,
  };
}

export function loadPacks(dir: string): Pack[] {
  const packs: Pack[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('_')) continue; // packs/_template is documentation, not a pack
    const packFile = join(dir, name, 'pack.json');
    if (!existsSync(packFile)) continue;
    const raw = JSON.parse(readFileSync(packFile, 'utf8')) as { lexicon?: string };
    const lexFile = join(dir, name, raw.lexicon ?? 'lexicon.json');
    const lexicon = JSON.parse(readFileSync(lexFile, 'utf8'));
    packs.push(validatePack(raw, lexicon, `packs/${name}`));
  }
  return packs;
}
