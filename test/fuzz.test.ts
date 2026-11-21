/**
 * Fuzz tests: random and mutated input must never crash the language parser or the
 * Poppy-Approval header parser, and must never produce a nonsense result.
 * Seeded (mulberry32), so a failure prints its seed and replays exactly. No dependencies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadPacks } from '../src/commerce/packs.ts';
import { Lexicon, normalizeText } from '../src/lexicon/normalize.ts';
import { parseApprovalHeader, formatApprovalHeader } from '../src/poppy/operations.ts';
import { mulberry32 } from '../mock-network/seller.ts';

const packs = loadPacks(join(import.meta.dirname, '..', 'packs'));
const lexicons = packs.map((p) => new Lexicon([p.lexicon]));
const ROUNDS = 3000;
const SEEDS = [1, 7, 2026];

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, max: number) => Math.floor(r() * max);

/** Random string from code points that tend to break parsers. */
function noise(r: () => number, maxLen: number): string {
  const ranges: Array<[number, number]> = [
    [0x20, 0x7e], [0x00, 0x1f], [0x0900, 0x097f], [0x0980, 0x09ff], [0x0b80, 0x0bff], [0x0c00, 0x0c7f],
    [0x0d00, 0x0d7f], [0x200b, 0x200f], [0x0660, 0x0669], [0xff00, 0xffef], [0x1f300, 0x1f64f],
  ];
  let s = '';
  for (let i = int(r, maxLen + 1); i > 0; i--) {
    const [lo, hi] = pick(r, ranges);
    s += String.fromCodePoint(lo + int(r, hi - lo + 1));
  }
  return s;
}

function mutate(r: () => number, s: string): string {
  const chars = [...s];
  for (let n = 1 + int(r, 4); n > 0; n--) {
    const at = int(r, chars.length + 1);
    switch (int(r, 3)) {
      case 0: chars.splice(at, 1); break;
      case 1: chars.splice(at, 0, ...noise(r, 2)); break;
      default: if (chars.length > 1) chars.splice(at, 0, chars[int(r, chars.length)]!); break;
    }
  }
  return chars.join('');
}

const SAMPLES = ['2 kilo atta aur 1 litre doodh', 'do kilo aata de do', 'मुझे दो किलो आटा और एक लीटर दूध चाहिए।', '२ किलो चीनी', 'dedh litre doodh', 'half kilo paneer', '2கிலோ அரிசி'];

test('lexicon: random and mutated text never throws and yields sane quantities', () => {
  let parsedSomething = 0;
  for (const seed of SEEDS) {
    const r = mulberry32(seed);
    for (let i = 0; i < ROUNDS; i++) {
      const input = i % 2 === 0 ? noise(r, 60) : mutate(r, pick(r, SAMPLES));
      for (const lex of lexicons) {
        let terms;
        try {
          terms = lex.parse(input);
        } catch (e) {
          assert.fail(`seed ${seed} round ${i}: parse threw ${(e as Error).message} on ${JSON.stringify(input)}`);
        }
        assert.ok(Array.isArray(terms));
        for (const t of terms) {
          assert.equal(typeof t.term, 'string', `seed ${seed} round ${i}`);
          if (t.quantity) {
            assert.ok(Number.isFinite(t.quantity.value) && t.quantity.value > 0, `seed ${seed} round ${i}: bad quantity ${t.quantity.value} for ${JSON.stringify(input)}`);
          }
        }
        if (terms.length > 0) parsedSomething++;
      }
    }
  }
  assert.ok(parsedSomething > 0, 'mutations of known phrases should sometimes still parse');
});

test('lexicon: very long and pathological input finishes quickly', () => {
  const lex = lexicons[0]!;
  const cases = ['a'.repeat(100_000), '1 '.repeat(50_000), 'kilo '.repeat(20_000), '\u200d'.repeat(100_000), 'दो '.repeat(30_000)];
  for (const c of cases) {
    const t0 = performance.now();
    lex.parse(c);
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `${c.slice(0, 10)}... took ${Math.round(ms)} ms`);
  }
});

test('normalizeText: never throws and is stable (normalising twice changes nothing more)', () => {
  for (const seed of SEEDS) {
    const r = mulberry32(seed);
    for (let i = 0; i < ROUNDS; i++) {
      const input = noise(r, 40);
      const once = normalizeText(input);
      assert.equal(normalizeText(once), once, `seed ${seed} round ${i}: not idempotent for ${JSON.stringify(input)}`);
    }
  }
});

test('Poppy-Approval: any string round-trips through format and parse', () => {
  for (const seed of SEEDS) {
    const r = mulberry32(seed);
    for (let i = 0; i < ROUNDS; i++) {
      const printable = (n: number) => {
        let s = '';
        for (let k = int(r, n) + 1; k > 0; k--) s += String.fromCharCode(0x20 + int(r, 0x5f));
        return s;
      };
      const a = { operation_id: printable(30), revision: printable(30) };
      assert.deepEqual(parseApprovalHeader(formatApprovalHeader(a)), a, `seed ${seed} round ${i}`);
    }
  }
});

test('Poppy-Approval: garbage and mutated headers never throw and never invent an approval', () => {
  const good = formatApprovalHeader({ operation_id: 'op_abc123', revision: '1790000000-xyz' });
  for (const seed of SEEDS) {
    const r = mulberry32(seed);
    for (let i = 0; i < ROUNDS * 2; i++) {
      const input = i % 2 === 0 ? noise(r, 80) : mutate(r, good);
      let out;
      try {
        out = parseApprovalHeader(input);
      } catch (e) {
        assert.fail(`seed ${seed} round ${i}: threw ${(e as Error).message} on ${JSON.stringify(input)}`);
      }
      if (out !== null) {
        assert.equal(typeof out.operation_id, 'string');
        assert.equal(typeof out.revision, 'string');
        // A parsed approval must really contain both members in the input text.
        assert.ok(input.includes('operation_id') && input.includes('revision'), `seed ${seed} round ${i}: approval from ${JSON.stringify(input)}`);
      }
    }
  }
});

test('Poppy-Approval: malformed headers are rejected', () => {
  const bad = [
    '', ' ', 'operation_id', 'operation_id="a"', 'revision="b"', 'operation_id="a" revision="b"', 'operation_id="a",', 'operation_id="a", revision="b',
    'operation_id="a", revision="b\\x"', 'operation_id="a\u0001", revision="b"', 'operation_id="é", revision="b"', 'OPERATION_ID="a", REVISION="b"',
    'operation_id=a, revision=b', 'operation_id=1, revision=2', ',,,', '=="', 'operation_id="a", revision="b" garbage',
  ];
  for (const h of bad) assert.equal(parseApprovalHeader(h), null, JSON.stringify(h));
});
