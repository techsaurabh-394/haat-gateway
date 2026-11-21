# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Signed approval receipts.** `GET /api/v1/operations/{id}/receipt` returns an Ed25519-signed record of what the person approved: operation, revision, time, channel (`header` or WhatsApp `link`), SHA-256 hashes of the exact summary and terms shown, and the commercial terms without the delivery address. The full text comes back unsigned to its owner only, and `verifyApprovedText` checks it against the hashes. `GET /.well-known/haat-receipt-keys.json` publishes the key; `HAAT_RECEIPT_KEY` pins it, else one is created and stored. The gate now records the approval in the same save that precedes the action (`OpRecord.approval`). Receipts are evidence from Haat, not an independent notary; no key rotation yet. See `docs/receipts.md`.

### Added
- **Operator endpoints.** `GET /healthz` (liveness) and `GET /readyz` (store read-back) are open and reveal nothing. `GET /metrics` (Prometheus text) and `GET /ops/overview` (stuck operations, pending confirms, per-seller answer rate and speed) need `HAAT_OPS_TOKEN` as a Bearer token, are off (404) without it, and use a constant-time compare. Labels use route patterns and status classes only. The overview carries no user keys, phone numbers, addresses or order contents. See `docs/operations.md`. No new dependencies.
- `Router.observe` and `BapClient.onResult` hooks; observer errors never break a request or an order.

### Added
- **Fuzz tests** (`test/fuzz.test.ts`): seeded random and mutated input for the language parser (all domain packs) and the `Poppy-Approval` header parser. Checks: never throws, quantities are finite and positive, normalising is idempotent, any header string round-trips, mutated headers never produce an approval that was not in the text, pathological 100k-character input stays fast.

### Fixed
- **"0 kilo atta" ordered a pack of atta.** A zero quantity was kept, and the basket rounds quantities up to at least one pack. The parser now drops an item with a zero quantity. Found by the fuzz tests.

### Added
- **Chaos seller** in the mock network. `startNetwork({ sellerChaos: { seed, silentRate, slowRate, slowMs, duplicateRate, badSignatureRate } })` makes the mock sellers answer `confirm`/`cancel` slowly, twice, with a forged signature first, or never. Runs are seeded (`mulberry32`) so a failure replays. `/_debug/chaos` shows how much chaos was injected. `test/chaos-seller.test.ts` checks that one approval never places more than one order, `confirm` is never sent twice, and a silent seller leaves the approval unresolved (503), under fixed and seeded mixed chaos. This is a test against the local mock network, not against real ONDC sellers.

### Added
- **WhatsApp approvals.** `POST /api/v1/operations/{id}/whatsapp` sends the approval summary to the signed-in account's verified phone with a single-use link; opening it shows the terms and a POST approves through the same gate. Tokens are stored hashed, tied to one revision and owner, limited to 3 sends per operation. `ApprovalGate.inspect()` and `approveStored()`, `MessageProvider` with mock, console and WhatsApp Cloud API providers, `docs/whatsapp.md`. The Cloud API provider is not verified against the live API (needs a Meta business account and an approved template).

### Fixed
- **One approval could confirm an order twice.** When a seller ACKed `confirm` but its `on_confirm` arrived after the timeout (or the request was cut off after it was sent), the approval gate treated it as a definite failure, set the operation back to `pending`, and sent `confirm` again when the agent retried the same approval. Now:
  - Beckn failures carry an outcome: `not_sent`, `rejected` or `unknown`. Only `not_sent` and `rejected` free an approval for reuse.
  - `perform` throws `OutcomeUnknownError` for an unknown outcome; the operation stays `performing` and answers `503 Retry-After`, and confirm is never sent again. Any error in `confirm` that is not a proven `not_sent` or `rejected` counts as unknown.
  - Every confirm is written to `confirm_pending` (not evictable) before it is sent. A late `on_confirm` that answers that exact message from that exact seller settles the operation (later approvals replay the order) or, if the seller rejected it, releases it.
  - Late callbacks are handed to `BapClient.onUnmatched` instead of being dropped.
  - A seller answer to `confirm` without an order id is now unknown, not a failure.
- The mock seller is idempotent per `transaction_id` for `confirm`.

### Added
- `ApprovalGate.settle()`, `release()` and `unresolved()`; `Commerce.lateConfirm()` and `pendingConfirms()`.
- `becknTimeoutMs` gateway option; `sellerConfirmDelayMs` and `/_debug/confirms` test hooks in the mock network.
- Tests: unknown outcomes in the gate, and an end-to-end test with a late `on_confirm` across a gateway restart.
- `AGENTS.md`: rules for coding agents working in this repository.

## [0.2.0] - unreleased

### Added
- Languages: Bhojpuri, Marathi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Punjabi and Odia, each in its own script and in Latin letters, plus number words, units, request words and "and" for each. **Machine-drafted; not yet reviewed by native speakers** (see docs/lexicon.md).
- Grocery lexicon grown from about 30 to 130 products; mock sellers now sell them, so search and basket work in the demo.
- Parser: digits of all Indian scripts, nukta removal in all scripts, zero-width joiner removal, Malayalam chillu normalisation, digit+letter splitting ("2கிலோ"), danda separators, variants stored without stopwords, longest matching variant wins.
- Tests for each language, script digits, number words, units, multi-word-beats-single-word, look-alike products, and a whole-file check that no variant belongs to two products.
- Sign-in: OAuth Direct Sign-In with PKCE, private_key_jwt client assertions (ES256, PS384), refresh, revocation, scopes and scope hints, saved addresses, account-owned orders and conversations, sign-in events in conversations (8.11).
- Poppy section 9: excluded-tasks document and feedback endpoint.
- Server-sent events for conversation events, with Last-Event-ID.
- PS384 delegations; RSA JWK thumbprints.
- Storage: SQLite via node:sqlite or bounded memory, with caps; operations, Sessions, orders and conversations survive restarts.
- ONDC: signed v2 registry lookups, onboarding endpoints, key generation and a subscribe template.
- ESLint, Dockerfile, docker compose, production entry point (`npm run serve`), CI jobs for lint, the official validator and Docker.
- Hindi README.

### Changed
- Phonetic key no longer folds `e` into `i`, so "tel" (oil) and "til" (sesame) are different words.
- The makhana test now uses a product that is really unknown ("dragon fruit"), since makhana is in the lexicon.
- Conversations are open to agents without the Operations extension; only ordering needs it (spec 3.3, found by the official validator).
- Feedback requires a verified Session header.
- An unknown cursor is `invalid_cursor` (400); `cursor_expired` (410) is for dropped events (8.13).

## [0.1.0] - unreleased

### Added
- Personal Agent Protocol draft 0.3: discovery, Session header verification with delegated keys, conversations (events, cursors, long polling, idempotent message IDs, handoff, close).
- Operations extension v2 approval gate for orders and cancellations: exact revisions, at most once, 503 when the outcome is unknown.
- Beckn buyer app: Ed25519 and BLAKE2b-512 signing, registry lookups, search fan-out, select, init, confirm, status and cancel.
- Hinglish and Hindi request parsing with a data-driven lexicon; basket builder.
- Grocery (RET10) and starter food (RET11) domain packs.
- Mock network: registry, Beckn gateway and three Varanasi sellers; reference Personal Agent; demo.
- Tests, CI, documentation and diagrams.
