/**
 * Turns a shopping request typed the way people in India actually type it, such as
 *   "do kilo aata aur 1 litre doodh"   or   "दो किलो आटा और एक लीटर दूध"   or   "இரண்டு கிலோ அரிசி"
 * into search terms with quantities:
 *   [{ term: "wheat flour", quantity: { value: 2000, unit: "g" } }, { term: "milk", quantity: { value: 1000, unit: "ml" } }]
 *
 * Matching is lexicon-first (packs/<pack>/lexicon.json, contributed by the community), with a
 * light phonetic key so spelling variants like "doodhh" / "dudh" / "dood" meet.
 * Known gaps are listed in docs/lexicon.md; this is deliberately simple and testable.
 */
export type LexiconFile = {
  version: number;
  entries: Array<{ term: string; category?: string; variants: string[] }>;
  stopwords?: string[];
  separators?: string[];
  numbers?: Record<string, number>;
  units?: Record<string, string>;
};

export type BaseUnit = 'g' | 'ml' | 'unit';
export type Quantity = { value: number; unit: BaseUnit };

export type Term = {
  /** The words the user typed for this item. */
  raw: string;
  /** Search term sent to sellers (lexicon term, or the raw words if nothing matched). */
  term: string;
  category?: string;
  matched: boolean;
  quantity?: Quantity;
};

/** Code point of the zero digit in each Indian script: Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam. */
const INDIC_ZERO_DIGITS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66];
/** Nukta signs (Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Telugu, Kannada). */
const NUKTAS = /[\u093C\u09BC\u0A3C\u0ABC\u0B3C\u0C3C\u0CBC]/g;
/** A letter of any Indian script from Devanagari to Malayalam. Such words are compared as written, not phonetically. */
const INDIC = /[\u0900-\u0D7F]/;
/** Malayalam atomic chillu letters and their older spelling (consonant + virama), so both encodings meet. */
const CHILLU: Record<string, string> = { '\u0D7A': '\u0D23\u0D4D', '\u0D7B': '\u0D28\u0D4D', '\u0D7C': '\u0D30\u0D4D', '\u0D7D': '\u0D32\u0D4D', '\u0D7E': '\u0D33\u0D4D' };

function indicDigit(d: string): string {
  const cp = d.codePointAt(0)!;
  for (const zero of INDIC_ZERO_DIGITS) if (cp >= zero && cp <= zero + 9) return String(cp - zero);
  return d;
}

/**
 * Lowercase and NFC; digits of every Indian script to ASCII (२, ২, ௨ and ౨ all become 2); nukta removed
 * (ड़ and ड compare equal); zero-width joiners removed; Malayalam chillu letters in one spelling.
 */
export function normalizeText(s: string): string {
  let out = s.normalize('NFD').replace(NUKTAS, '').normalize('NFC').toLowerCase();
  out = out.replace(/[\u200c\u200d]/g, '').replace(/[\u0D7A-\u0D7E]/g, (c) => CHILLU[c] ?? c);
  return out.replace(/\p{Nd}/gu, indicDigit);
}

/**
 * Phonetic key for romanised Hindi spelling variants. Applied to both sides of a comparison,
 * so it only has to be consistent, not linguistically correct.
 */
export function phoneticKey(word: string): string {
  const w = normalizeText(word);
  if (INDIC.test(w)) return w.replace(/\s+/g, ' ').trim();
  let k = w.replace(/[^a-z ]/g, '');
  k = k.replace(/ph/g, 'f').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/ck/g, 'k');
  k = k.replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ou/g, 'u');
  k = k.replace(/(.)\1+/g, '$1'); // collapse repeated letters: aataa -> ata, doodhh -> dudh
  k = k.replace(/o/g, 'u').replace(/y\b/g, 'i');
  k = k.replace(/([^aiu ])h/g, '$1'); // aspiration is often dropped: dudh/dud, bhindi/bindi
  // No final-vowel dropping: it made "makhana" (fox nuts) equal "makhan" (butter). See test/lexicon.test.ts.
  return k.replace(/\s+/g, ' ').trim();
}

type CompiledEntry = { term: string; category?: string; keys: string[][] };

export class Lexicon {
  entries: CompiledEntry[] = [];
  stop = new Set<string>();
  separators = new Set<string>();
  numbers = new Map<string, number>();
  units = new Map<string, string>();

  constructor(files: LexiconFile[]) {
    for (const f of files) {
      for (const s of f.stopwords ?? []) this.stop.add(normalizeText(s));
      for (const s of f.separators ?? []) this.separators.add(normalizeText(s));
      for (const [k, v] of Object.entries(f.numbers ?? {})) this.numbers.set(normalizeText(k), v);
      for (const [k, v] of Object.entries(f.units ?? {})) this.units.set(normalizeText(k), v);
    }
    for (const f of files) {
      for (const e of f.entries) {
        const keys = e.variants.concat(e.term).map((v) => this.variantKey(v)).filter((k) => k.length > 0);
        this.entries.push({ term: e.term, category: e.category, keys });
      }
    }
    // Longest variants first, so "sarson ka tel" wins over "tel".
    this.entries.sort((a, b) => Math.max(...b.keys.map((k) => k.length)) - Math.max(...a.keys.map((k) => k.length)));
  }

  /**
   * A variant as the words parse() will see: cleaned like the input, with stopwords removed, so
   * "sarson ka tel" meets "sarson tel" and "ਸਰ੍ਹੋਂ ਦਾ ਤੇਲ" meets "ਸਰ੍ਹੋਂ ਤੇਲ".
   */
  private variantKey(variant: string): string[] {
    const words = normalizeText(variant).replace(/[^\p{L}\p{M}\d ]/gu, ' ').split(/\s+/).filter(Boolean);
    const content = words.filter((w) => !this.stop.has(w));
    return (content.length > 0 ? content : words).map(phoneticKey).filter(Boolean);
  }

  /** Splits a request into items and returns one Term per item. */
  parse(input: string): Term[] {
    const text = normalizeText(input)
      .replace(/(\d)(\p{L})/gu, '$1 $2') // "2kg" -> "2 kg", "2கிலோ" -> "2 கிலோ"
      .replace(/[,;&+\n।॥]/g, ' , ')
      .replace(/\.(?!\d)/g, ' ')
      .replace(/[^\p{L}\p{M}\d., ]/gu, ' ');
    const tokens = text.split(/\s+/).filter(Boolean);
    const segments: string[][] = [[]];
    for (const t of tokens) {
      if (t === ',' || this.separators.has(t)) segments.push([]);
      else segments[segments.length - 1]!.push(t);
    }
    const terms: Term[] = [];
    for (const seg of segments) {
      const term = this.parseSegment(seg);
      if (term) terms.push(term);
    }
    return terms;
  }

  private parseSegment(tokens: string[]): Term | null {
    let quantity: Quantity | undefined;
    const words: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      const next = tokens[i + 1];
      const num = /^\d+(\.\d+)?$/.test(t) ? Number(t) : this.numbers.get(t);
      // A number word only counts as a quantity when something follows it ("do kilo atta"),
      // so the Hindi "do" in "atta de do" (give) stays a stopword.
      if (num !== undefined && quantity === undefined && next !== undefined) {
        const unit = this.units.get(next);
        if (unit) {
          quantity = toBase(num, unit);
          i++;
          continue;
        }
        if (!this.stop.has(next) || /^\d/.test(t)) {
          quantity = { value: num, unit: 'unit' };
          continue;
        }
      }
      if (num !== undefined && /^\d/.test(t) && next === undefined && quantity === undefined) {
        quantity = { value: num, unit: 'unit' };
        continue;
      }
      if (this.units.has(t) && quantity === undefined) continue; // stray unit word
      if (this.stop.has(t)) continue;
      if (t === '.') continue;
      words.push(t);
    }
    if (words.length === 0) return null;
    const raw = words.join(' ');
    const match = this.match(words);
    return match
      ? { raw, term: match.term, category: match.category, matched: true, ...(quantity ? { quantity } : {}) }
      : { raw, term: raw, matched: false, ...(quantity ? { quantity } : {}) };
  }

  /** The product whose matching variant is longest: "thengai ennai" is coconut oil, not cooking oil ("ennai"). */
  private match(words: string[]): CompiledEntry | null {
    const keys = words.map(phoneticKey);
    let best: CompiledEntry | null = null;
    let bestLength = 0;
    for (const e of this.entries) {
      for (const k of e.keys) {
        if (k.length <= bestLength || k.length > keys.length) continue;
        for (let i = 0; i + k.length <= keys.length; i++) {
          if (k.every((part, j) => part === keys[i + j])) {
            best = e;
            bestLength = k.length;
            break;
          }
        }
      }
    }
    return best;
  }
}

export function toBase(value: number, unit: string): Quantity {
  switch (unit) {
    case 'kg':
      return { value: value * 1000, unit: 'g' };
    case 'g':
      return { value, unit: 'g' };
    case 'l':
      return { value: value * 1000, unit: 'ml' };
    case 'ml':
      return { value, unit: 'ml' };
    case 'dozen':
      return { value: value * 12, unit: 'unit' };
    default:
      return { value, unit: 'unit' };
  }
}

/** Parses an ONDC item measure ({unit: "kilogram", value: "1"}) into base units. */
export function measureToBase(measure: { unit: string; value: string } | undefined): Quantity | undefined {
  if (!measure) return undefined;
  const v = Number(measure.value);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  const u = measure.unit.toLowerCase();
  if (u.startsWith('kilo')) return { value: v * 1000, unit: 'g' };
  if (u === 'gram' || u === 'grams' || u === 'g') return { value: v, unit: 'g' };
  if (u.startsWith('litre') || u.startsWith('liter') || u === 'l') return { value: v * 1000, unit: 'ml' };
  if (u.startsWith('milli')) return { value: v, unit: 'ml' };
  if (u === 'dozen') return { value: v * 12, unit: 'unit' };
  return { value: v, unit: 'unit' };
}

export function formatQuantity(q: Quantity): string {
  if (q.unit === 'g') return q.value >= 1000 ? `${q.value / 1000} kg` : `${q.value} g`;
  if (q.unit === 'ml') return q.value >= 1000 ? `${q.value / 1000} L` : `${q.value} ml`;
  return `${q.value}`;
}
