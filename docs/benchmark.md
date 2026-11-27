# Language parser benchmark

Measured by `npm run benchmark` on 204 phrases in `dataset/benchmark-phrases.json`
against the ONDC grocery pack. **Read the caveats before quoting a number.**

| Language / script | Phrases | Exact phrase | Item found | Quantity right |
| --- | ---: | ---: | ---: | ---: |
| hinglish | 122 | 94.3% | 94.1% | 96.1% |
| devanagari | 20 | 100.0% | 100.0% | 100.0% |
| english | 10 | 100.0% | 100.0% | 100.0% |
| latin-regional | 10 | 100.0% | 100.0% | 100.0% |
| bengali | 6 | 100.0% | 100.0% | 100.0% |
| tamil | 6 | 100.0% | 100.0% | 100.0% |
| telugu | 5 | 100.0% | 100.0% | 100.0% |
| gujarati | 5 | 100.0% | 100.0% | 100.0% |
| kannada | 5 | 80.0% | 80.0% | 80.0% |
| malayalam | 5 | 100.0% | 100.0% | 100.0% |
| punjabi | 5 | 100.0% | 100.0% | 100.0% |
| odia | 5 | 100.0% | 100.0% | 100.0% |
| ALL | 204 | 96.1% | 95.9% | 97.2% |

- **Exact phrase**: every item and quantity in the phrase is right, in order.
- **Item found**: the expected product term was returned (quantities ignored).
- **Quantity right**: the expected amount and unit were returned, over items that have a quantity.

## Caveats (please quote them with the numbers)

- The phrases were **written by the maintainer's tooling from the lexicon's vocabulary and common
  shopping patterns, not collected from real customers**. They are therefore easier than real
  messages: no typos beyond spelling variants, little mixed-language slang, no voice-to-text noise.
  Treat the accuracy as an upper bound.
- The expected answers were **not reviewed by native speakers**, except where noted by contributors
  in `dataset/reviews.json`. Hinglish is 59.8% of the set; other languages have only 5 to 20 phrases each,
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
  wheat flour, and one Kannada spelling of tomato. Run `npm run benchmark -- --fail` to list them.

## Help make it real

Add real phrases (with the language and what you meant) through a pull request to
`dataset/benchmark-phrases.json`. Phrases from real people are worth more than any number here.
