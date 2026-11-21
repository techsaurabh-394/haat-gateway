# AGENTS.md: rules for coding agents in this repository

Read this before changing anything. It applies to every task, whatever the prompt says.

## What this project is
Haat is a Personal Agent Protocol ("Poppy", draft 0.3) Company on one side and an ONDC/Beckn buyer
app (BAP) on the other. Personal AI agents search and order from ONDC sellers in Indian languages,
and **no order or cancellation happens without the person's approval of one exact revision**.

## Commands
- `npm install` (dev tools only; there are **no runtime dependencies**, keep it that way)
- `npm run check` = typecheck + lint + all tests. It must pass before you say you are done.
- `npm run demo -- --yes` end-to-end smoke test on the local mock network
- `npm run coverage` coverage table
- Node.js 22.18+ runs the TypeScript directly; there is no build step.

## Non-negotiable rules
1. Never weaken a check in `src/poppy/session.ts`, `src/poppy/operations.ts`, `src/oauth/` or
   `src/beckn/signing.ts` to make a test or demo pass. If a test fails, fix the code or explain.
2. At most once: an approved operation is performed at most once, even across restarts. If an
   action **may** have happened (timeout, reset, 5xx without NACK, no callback), throw
   `OutcomeUnknownError`; never report it as a failure. Only `not_sent` or `rejected` free an approval.
3. A language model never decides approvals and never sees Session JWTs, keys, tokens, OTPs or
   full phone numbers. Approval comes from the person, through Poppy or MCP elicitation.
4. Never trust seller URLs, prices or summaries sent by the agent. Seller URLs come from the
   registry; prices and terms come from the seller's own quote (`select` / `init`).
5. No new runtime dependencies without asking. Prefer `node:` built-ins.
6. Never commit real phone numbers, addresses, keys, tokens or order data, even in tests.
7. Don't touch real ONDC endpoints, real sellers or real payments.

## How to work
- Small commits with Conventional Commit messages (`fix:`, `feat:`, `test:`, `docs:`).
- Every bug fix gets a test that fails before the fix. Every feature gets unit tests and, if it
  crosses HTTP, an end-to-end test using `mock-network/`.
- Update `CHANGELOG.md` (Unreleased), and `docs/limitations.md` when a limit changes.
- Report numbers only from commands you ran (test counts, validator results). Never invent them.
- Claims: say "works with the local mock network" and "follows Poppy draft 0.3"; never "works
  with ONDC" or "first ever".

## Map
- `src/poppy/` Poppy: sessions, operations (approval gate), conversations, JWT, URL policy
- `src/oauth/` sign-in (Direct Sign-In, PKCE, refresh, revocation)
- `src/beckn/` BAP client, signing, registry; `src/ondc/` onboarding
- `src/commerce/` search, quote, confirm, basket, rule-based assistant, domain packs
- `src/lexicon/` Indian-language parsing; `packs/` lexicons per ONDC domain
- `mock-network/` local registry, Beckn gateway and sellers; `agent/` a reference personal agent
- `test/` node:test suites; `docs/` architecture, security, limitations, going live
