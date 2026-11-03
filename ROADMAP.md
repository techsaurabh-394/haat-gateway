# Roadmap

Dates are targets, not promises. Each milestone is a GitHub milestone with linked issues.

## v0.1: works locally (done)

Poppy discovery, Sessions and conversations; Operations v2 approval gate; Beckn buyer app; Hinglish lexicon; basket builder; mock network; demo.

## v0.2: spec coverage, durability, readiness (done)

Sign-in (Direct Sign-In, refresh, revocation, scopes, saved addresses), Poppy section 9, SSE streaming, PS384 delegations, SQLite storage with caps and crash-safe operations, lint, Docker, official validator in CI (99 passed, 0 failed), ONDC onboarding tooling, Hindi README.

## v0.3: real network

- ONDC pre-production subscription (owner steps in docs/going-live.md)
- Full retail contract fields for RET10, and ONDC log verification
- Issue and grievance management (IGM) basics
- Automatic reconciliation of operations interrupted mid-confirm (Beckn `status`)
- A real SMS provider behind `OtpProvider`

## v0.4: reach

- Device Sign-In (4.3) and DPoP-bound tokens (4.5)
- Browser join (section 6) and an MCP API (section 7)
- Native-speaker review of the machine-drafted lexicon for Bhojpuri, Marathi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Punjabi and Odia (the data exists since v0.2; review, real-usage variants and more regional words are what is left), then the same languages for the food pack
- Optional local open-weight model for intent detection in conversations, with approvals kept outside the model

Ideas are welcome in [Discussions](https://github.com/techsaurabh-394/haat-gateway/discussions/categories/ideas).
