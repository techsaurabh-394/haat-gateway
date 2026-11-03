# Contributing to Haat

Thank you for helping personal AI agents work for people across India. You don't need to know TypeScript to make a useful contribution: language data, domain packs, mock sellers and docs are all JSON or Markdown.

## Your first pull request in about 10 minutes

1. Pick an issue labelled [`good first issue`](https://github.com/techsaurabh-394/haat-gateway/labels/good%20first%20issue) and comment "I'd like to take this".
2. Follow the Git steps below.
3. Run `npm test`.
4. Open the pull request and fill in the checklist.

A maintainer aims to reply within 48 hours. If you're stuck, ask in the issue or in [Discussions](https://github.com/techsaurabh-394/haat-gateway/discussions); questions are contributions too.

## Set up

You need Node.js 22.18 or newer and Git.

```bash
# one time: fork on GitHub first, then
git clone https://github.com/<your-username>/haat-gateway.git
cd haat-gateway
git remote add upstream https://github.com/techsaurabh-394/haat-gateway.git
npm install
npm test            # everything should pass before you change anything
npm run demo -- --yes
```

## Every contribution

```bash
git checkout main
git pull upstream main                       # get the latest
git checkout -b lexicon/add-bhojpuri-veg     # one branch per change
# ...make your change...
npm run check                                # typecheck + lint + tests
git add -A
git commit -m "lexicon: add Bhojpuri vegetable names"
git push origin lexicon/add-bhojpuri-veg     # push to YOUR fork
# open a Pull Request on GitHub
```

If `main` moves while your PR is open:

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease
```

## What to contribute

| You know… | Good contributions |
| --- | --- |
| How people in your region type shopping lists | Lexicon variants and tests ([docs/lexicon.md](docs/lexicon.md)). **Native-speaker review of Bhojpuri, Marathi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Punjabi and Odia is the most wanted help: that data is machine-drafted.** |
| A product category | A domain pack ([docs/domain-packs.md](docs/domain-packs.md)) |
| Local shops | A mock seller catalog in `mock-network/sellers/` |
| TypeScript | Issues labelled `help wanted`: spec coverage, persistence, SSE streaming |
| Security | Review `src/poppy/session.ts` and `src/poppy/operations.ts` against the spec |
| Writing | Docs, translations of the README, tutorials |

## Rules of the road

- **Tests with every behaviour change.** Bug fixes come with a test that failed before the fix.
- **Spec references.** Code that implements the Personal Agent Protocol cites the section in a comment (for example `// spec 5.3 step 4`). If the spec is ambiguous, say what you chose and why.
- **No runtime dependencies** without discussion. The gateway handles money-adjacent actions, and a small dependency tree is part of its security.
- **Honest docs.** Don't claim something works against real ONDC or a real agent unless you tested it, and say how.
- **Commit messages:** `area: what changed`, for example `poppy: verify PS384 delegations` or `lexicon: add Marathi dairy terms`.
- **Personal data:** never commit real phone numbers, addresses or order data, even in tests. Use clearly fake values.

## Code style

TypeScript with only erasable syntax (Node runs it directly): no `enum`, no parameter properties, no namespaces, and `.ts` extensions in imports. `npm run typecheck` and `npm run lint` must pass. The lint rules target real bugs, such as a forgotten `await` next to an order. Prefer small functions and plain data.

## Credit

Every contributor, code or not, is listed in the README contributors section via the all-contributors bot. Comment `@all-contributors please add @username for code, doc, data` on a PR.

By contributing you agree that your work is licensed under the MIT License, and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Language data

- Edit `packs/ondc-ret10-grocery/lexicon.json`. One product per entry; a variant may belong to only one product (the tests check exact and phonetic collisions across all languages).
- Write each variant the way people type it, in the language's own script and in Latin letters. Mark what you are unsure of in the PR description.
- Do not present machine-drafted or unchecked words as verified. If you reviewed a language, say so in the PR so docs/lexicon.md can be updated.
- Add a line to `test/lexicon.test.ts` for anything that was wrong or ambiguous. Run `npm run check`.
