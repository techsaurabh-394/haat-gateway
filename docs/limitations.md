# Limitations, stated plainly

This is v0.2. Here is what it does **not** do, so nobody is surprised.

## Not live on ONDC

All ordering has run only against the mock network in this repository. The onboarding pieces (keys, signed `request_id`, site verification, `on_subscribe`, signed v2 lookup) follow ONDC's official documents and reference code, and are tested against themselves, but **have not been run against ONDC's registry**. Going live needs things only the owner can do: a legal entity, whitelisting on ONDC's portal, a filled-in subscribe request checked against ONDC's SwaggerHub spec, and ONDC's approval of an agent-facing buyer app. See [going-live.md](going-live.md).

The retail contract is partial: many optional fields, tags, `@ondc/org/*` extensions, settlement details, and issue and grievance management (IGM) are not implemented.

## Poppy coverage

| Spec area | Status |
| --- | --- |
| Discovery (3) | Done, with issuer |
| Direct Sign-In, refresh, revocation (4.1, 4.2, 4.4, 4.6, 4.7) | Done; checked by Haat's tests and the validator's metadata and assertion checks |
| Device Sign-In (4.3) | Not implemented |
| DPoP-bound access tokens (4.5) | Not implemented (Bearer only; allowed by the spec) |
| Tokens for one service (`resource`, RFC 8707) | Not needed: one service |
| Session header (5.2, 5.3) | Done, ES256 and PS384 delegations |
| Operator signatures / Web Bot Auth (5.3) | Not implemented (SHOULD, on the agent side) |
| Web browsing join (6) | Not implemented |
| APIs (7) | OpenAPI done; MCP API not implemented |
| Conversations (8) | Done, including SSE; text-delta streaming, Direct Conversations (8.10) and a staffed handoff are not |
| Task coverage (9) | Done |
| Operations extension v2 | Done for API and conversations |
| Mediated Sign-In extension | Not implemented |

## Sign-in

- Accounts are identified by a mobile number with a one-time code. **Sending real codes needs an SMS provider**: implement `OtpProvider` in `src/oauth/server.ts`. The built-in provider is a development stand-in that accepts a fixed code, says so on the page, and refuses to start outside dev mode.
- No account settings page yet (disconnecting an agent from the Company's side).

## Language understanding

- The grocery lexicon covers 130 products in Hindi and ten more Indian languages (Bhojpuri, Marathi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Punjabi, Odia), each in its own script and in Latin letters. **Only Hindi was written by hand; the other languages are machine-drafted and have not been reviewed by native speakers**, so some words will be wrong or unnatural. Everything not in the lexicon is searched with the raw words. See [lexicon.md](lexicon.md).
- Dialects, mixed-language sentences beyond simple lists, brands, and pack sizes inside text are not understood.
- Phonetic matching is a heuristic, tested on the variants in `test/lexicon.test.ts`, not on real user logs.

## Operations and scale

- Single process. SQLite (`node:sqlite`, marked experimental by Node) suits one instance; several instances need a shared store.
- When the seller's answer to `confirm` is missing (timeout, connection reset, a 5xx without a NACK, or a crash mid-confirm), the operation answers `503` and confirm is never sent again. A late `on_confirm` settles it automatically, also after a restart, because each confirm is recorded on disk before it is sent. If the seller never answers, it stays unresolved until an operator checks with the seller: `gate.unresolved()` and `commerce.pendingConfirms()` list these cases, but there is no operator command or Beckn `status` reconciliation yet (status needs an order id, which a missing `on_confirm` never gave us).
- Cancellation does not yet get the same treatment: a cancel whose outcome is unknown is reported as failed. Sending cancel twice is harmless, so this is lower priority.
- Memory mode is bounded, but evicted state is lost; use SQLite (`HAAT_DB`) for anything real.
- Outbound fetches of agent metadata are limited (HTTPS, no private addresses, no redirects, size and time limits, failure cache), but hostnames are not DNS-pinned before connecting.

## Numbers

The test count and the validator results are what the commands reported when they were last run (see CHANGELOG.md). Nothing has been benchmarked, including language understanding, and none of this has run against real ONDC.
