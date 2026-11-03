# Repository audit (1 November 2026, updated for v0.2)

A full review of what this repository covers, what it doesn't, and what not to do with it. Re-run the commands at the bottom after big changes.

## Coverage of a full open-source repository

| Area | Status | Where |
| --- | --- | --- |
| Working code with no runtime dependencies | ✅ | `src/`, `agent/`, `mock-network/` |
| Tests: unit + end-to-end over real HTTP | ✅ 126 passing | `test/` |
| Official Poppy validator | ✅ 99 passed, 0 failed, 0 warnings (22 skipped: features not offered) | `docs/conformance.md` |
| Lint (bug-focused rules) | ✅ clean | `eslint.config.js` |
| Line / branch coverage | ✅ 97% / 81% overall (weakest: `assistant.ts` 81% lines, `bap.ts` 85%) | `npm run coverage` |
| Typecheck in CI, Node 22 and 24 | ✅ (never run on GitHub yet) | `.github/workflows/ci.yml` |
| Demo smoke test in CI | ✅ | same |
| README with demo, diagrams, status, limits | ✅ | `README.md`, `assets/` |
| Light/dark, reduced-motion visuals | ✅ checked in a real browser | `assets/`, `scripts/assets/make_diagrams.py` |
| Architecture, protocol mapping, flowcharts | ✅ | `docs/architecture.md`, `docs/protocol-mapping.md` |
| Security model and private reporting | ✅ | `docs/security.md`, `SECURITY.md` |
| Honest limitations | ✅ | `docs/limitations.md`, `docs/going-live.md` |
| CONTRIBUTING with Git workflow | ✅ | `CONTRIBUTING.md` |
| Code of Conduct, Governance, Roadmap, Changelog, Citation, License | ✅ | root |
| Issue forms, PR checklist, CODEOWNERS, labels, Dependabot, funding | ✅ | `.github/` |
| Welcome bot, all-contributors config | ✅ (the app must be installed) | `.github/workflows/welcome.yml`, `.all-contributorsrc` |
| 20 good first issues + creation scripts | ✅ | `docs/good-first-issues/`, `scripts/github/` |
| Publish, launch and next-version guides | ✅ | `docs/PUSH_TO_GITHUB.md`, `docs/launch.md`, `docs/CLAUDE_CODE_PROMPT.md` |
| Accidental npm publish blocked | ✅ `"private": true` | `package.json` |
| Persistence, memory limits | ✅ SQLite or bounded memory, caps, crash-safe operations | `src/store/kv.ts` |
| OAuth sign-in, SSE, Poppy section 9, PS384 | ✅ | `src/oauth/`, `src/gateway.ts` |
| Real ONDC connection | ⚠️ tooling done (keys, onboarding endpoints, signed lookup); live subscription needs the owner's legal entity and ONDC approval | `docs/going-live.md` |
| Docker image | ⚠️ written; built only in CI (no Docker where it was written) | `Dockerfile` |
| Hindi README | ⚠️ written, needs a native speaker's review (issue 16) | `README.hi.md` |
| Real SMS for sign-in codes | ❌ issue 12 | `src/oauth/server.ts` |

## Fixed during this audit

- Removed an **unverified claim** that Anthropic's Claude Duet supports Poppy (README, hero, diagram, code comment, launch post). The sources only show Sierra's demo with Meta's Muse.
- Two **timing-dependent** end-to-end tests could fail on a slow CI runner; they now tolerate timing.
- Verifying a Session could make the gateway fetch the same failing URL repeatedly; added a 60-second failure cache, with a test.
- Added `"private": true`, `.gitattributes`, a contributors section, `npm run coverage`, and a CodeQL step in the publish guide.
- Documented unbounded memory growth, and added a "don't deploy publicly yet" warning to the README.

## What not to do

**With the code**
1. Don't deploy it publicly without `HAAT_DB`, a real `OtpProvider` (or `HAAT_SIGN_IN=off`), and a per-IP rate limit at your proxy.
2. Don't point it at real ONDC endpoints, real sellers, or real payments until `docs/going-live.md` is worked through, including ONDC policy approval.
3. Don't weaken a check in `src/poppy/session.ts` or `src/poppy/operations.ts` to make a test or a demo pass.
4. Don't let a language model decide approvals or see Session JWTs, keys or tokens. The rule-based assistant is deliberate.
5. Don't trust seller URLs, prices or summaries from the agent's request; they come from the registry and the seller's own quote.
6. Don't add runtime dependencies casually.
7. Don't commit real phone numbers, addresses, keys or order data, even in tests.

**With claims**
8. Don't say "first ever" or "nobody has built this". Say what you searched and when.
9. Don't say "works with ONDC" or "works with Muse". Say "works with a local mock network" and "follows Poppy draft 0.3".
10. Don't publish numbers you didn't measure (users, latency, accuracy).
11. Don't present the Poppy spec as stable: it went from 0.1 to 0.3 in October 2026.
12. Don't imply affiliation with ONDC, Sierra, Meta or the Personal Agent Protocol project.

**With the community**
13. Don't announce before CI is green on GitHub and 3 to 5 people have tried a first PR.
14. Don't post the same link to many communities at once; read each one's rules.
15. Don't leave first-time contributors waiting; the docs promise a reply within 48 hours.
16. Don't merge lexicon changes in a language you can't read without a second native-speaker review.

## Re-run the audit

```bash
npm run check          # typecheck + tests
npm run coverage       # coverage table
npm run demo -- --yes  # end-to-end smoke test
scripts/github/create-issues.sh owner/repo --dry-run
```
