# The lexicon (Hinglish and ten more Indian languages)

![Hinglish pipeline](../assets/hinglish-pipeline.svg)

People in India type shopping lists in English, in Hindi written in Latin letters ("Hinglish"), in their own script, and in mixtures. Sellers list products in English. The lexicon bridges that.

## Coverage

The grocery pack (`packs/ondc-ret10-grocery/lexicon.json`) has **130 products** (grains, pulses, dry fruits, vegetables, fruits, spices, oils, dairy, snacks, beverages, household) and variants for these languages, each in its own script **and** in Latin letters:

| Language | Code | Language | Code |
| --- | --- | --- | --- |
| Hindi | `hi`, `hi-Latn` | Gujarati | `gu`, `gu-Latn` |
| Bhojpuri | `bho`, `bho-Latn` | Kannada | `kn`, `kn-Latn` |
| Marathi | `mr`, `mr-Latn` | Malayalam | `ml`, `ml-Latn` |
| Bengali | `bn`, `bn-Latn` | Punjabi | `pa`, `pa-Latn` |
| Tamil | `ta`, `ta-Latn` | Odia | `or`, `or-Latn` |
| Telugu | `te`, `te-Latn` | English | `en` |

Each language also has number words (1 to 10, half, one-and-a-half, two-and-a-half), units (kilo, litre, gram, dozen, packet, piece), request words to ignore (such as "I want" and "please give") and the word for "and".

## Not verified by native speakers

**Hindi was written by hand. The data for every other language was drafted by a machine (an AI model) and has not been reviewed by native speakers.** Expect wrong or unnatural words, missing regional names, and spellings people do not really use. The tests check that the parser behaves consistently on this data; they do not prove the words are right. The Latin-letter spellings are guesses at how people type, not observed usage.

If you speak one of these languages, please review it: fix a variant, add what your family says, and remove what nobody says. See [CONTRIBUTING.md](../CONTRIBUTING.md). Until a language has been reviewed, treat it as a starting point.

Also note: Bhojpuri shares many product words with Hindi, so its own list is short and mostly adds regional words (for example *chaur* for rice and *chura* for flattened rice). A word that several languages use for different products can be listed under only one product; such clashes were resolved by hand and are listed below.

## Format

```json
{
  "entries": [
    { "term": "milk", "category": "Dairy", "variants": ["milk", "doodh", "dudh", "dood", "दूध"] }
  ],
  "stopwords": ["mujhe", "chahiye", "मुझे"],
  "separators": ["aur", "and", "और"],
  "numbers": { "do": 2, "aadha": 0.5, "दो": 2 },
  "units": { "kilo": "kg", "litre": "l", "packet": "unit", "दर्जन": "dozen" }
}
```

- `term` is what sellers are searched for. Keep it in plain English, the way catalogs name things.
- `variants` are ways people actually type it. Add what you see in real messages, not every possible spelling.
- One product per entry. A variant may belong to only one term (the tests enforce this).

## How matching works

1. Text is lowercased and normalised. Digits of every Indian script (२ ২ ௨ ౨ ૨ ೨ ൨ ੨ ୨) become ASCII digits, nukta signs are removed in all scripts, zero-width joiners are removed, and Malayalam chillu letters are written one way. A digit stuck to a unit ("2கிலோ") is split.
2. The text is split into items on separators (`aur`, `and`, `ani`, `ebong`, `,`, the danda `।`, …).
3. Quantities are read: digits or number words, then a unit. A number word counts only if something follows it, so the "do" in "atta de do" (give) is ignored.
4. Stopwords are dropped. Variants are stored without stopwords too, so "sarson ka tel" and "sarson tel" meet.
5. Latin-letter words are matched through a phonetic key: repeated letters collapse, `ee`→`i`, `oo`→`u`, aspiration is dropped (`dh`→`d`). Words in Indian scripts are compared as written (after normalisation). The **longest** matching variant wins, so "thengai ennai" (coconut oil) beats "ennai" (oil).
6. No match? The raw words are searched as-is, so nothing is lost.

## Lessons pinned by tests

- Dropping a final vowel made **makhana** (fox nuts) equal **makhan** (butter). That rule was removed, and a regression test keeps it out.
- "do" is both "two" and "give"; position decides.
- The phonetic key used to turn `e` into `i`. That made Latin "tel" (oil) equal "til" (sesame), so the rule was removed and `til`/`tel` are tested apart.

## Known ambiguities and limits

- "chai" is tea in Hindi but "want" in Bengali. It is kept as tea; Bengali "want" words that clash are left out of the stopwords.
- "arai" is half in Tamil but two-and-a-half in Bengali; Bengali two-and-a-half is spelled "arhai" instead.
- The phonetic key drops the `h` of `gh`, so Latin "ghol" (Bengali buttermilk) sounds like "gul" (jaggery). Bengali buttermilk is listed in Bengali script only.
- The same word can mean different things in different languages or regions. The tests only catch clashes inside this file; clashes with words people really type but that are not listed here are unknown.
- Compound dishes, brands and pack sizes in text ("Aashirvaad 5 kg") are not understood; unknown words are searched as written.
- The test `no variant is claimed by two products` checks both exact spellings and the phonetic key across the whole file, for all languages.

## Contributing language data

The best contributions come from how *your* family and neighbourhood type. Use the "Lexicon addition" issue form or open a PR that adds variants and a test line in `test/lexicon.test.ts`. **Native-speaker review of every non-Hindi language is the most useful contribution right now.**
