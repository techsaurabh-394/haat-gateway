# Haat grocery lexicon dataset

`grocery-lexicon.json` is a plain JSON file: **130 grocery and household products** with the ways
people type each one, grouped by writing system. It is the same data the Haat parser uses
(`packs/ondc-ret10-grocery/lexicon.json`), exported so you can use or cite it without running
anything. Licence: MIT.

    npm run export:lexicon      # regenerates grocery-lexicon.json from the pack

## Shape

    {
      "groups": {
        "devanagari": { "covers": "Hindi, Marathi, Bhojpuri (Devanagari script)", "variants": 309,
                        "reviewed": false, "reviewers": [], "note": "..." },
        ...
      },
      "entries": [
        { "term": "milk", "category": "Dairy",
          "variants": { "latin": ["doodh", "dudh", ...], "devanagari": ["दूध", ...], "tamil": ["பால்"], ... } }
      ]
    }

## Be careful with the language labels

The lexicon does not record which language a variant belongs to, so the dataset groups by
**script**, not language: Hindi, Marathi and Bhojpuri all share Devanagari, and every language
typed in Latin letters (Hinglish, Tanglish, ...) shares the `latin` group. Splitting these by
language is exactly the kind of help we need (see below). The pack declares 11 languages; this
file does not claim 11 reviewed ones.

## Review status: honest by default

| Flag | Meaning |
| --- | --- |
| `reviewed: false` | No native speaker has checked this group. Hindi was hand-written by the maintainer; every other language was machine-drafted. |
| `reviewed: true` | At least one named native speaker checked every entry in the group (see `reviewers`). |

Today **every group is `reviewed: false`**. Nothing here is a claim of correctness.

## Review a language (no coding needed)

1. Open `grocery-lexicon.json` and find your script (for example `tamil`).
2. For each product, check the variants: wrong word? missing common word? a spelling people really
   use? Edit `packs/ondc-ret10-grocery/lexicon.json` (the source of truth), or just list the
   problems in an issue and we will fix them.
3. When you have gone through the whole group, add yourself in `dataset/reviews.json`:
   `"tamil": { "reviewed": true, "reviewers": ["your-github-name"], "note": "Tamil, Chennai Tamil" }`
4. Run `npm run export:lexicon` and open a pull request. We merge reviews quickly.

Partial reviews are welcome too: say which products you checked in the note and leave
`reviewed` as `false`.

## Also here

- `benchmark-phrases.json`: 204 phrases used by `npm run benchmark` (see `docs/benchmark.md`).
  Real phrases from real people are the most valuable contribution.
- `reviews.json`: the review flags read by the exporter.

## Cite

See `CITATION.cff` in the repository root.
