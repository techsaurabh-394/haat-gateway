# Prompt for Claude Code: build Haat v0.3

Paste the block into Claude Code (an Opus model), started inside the `haat-gateway` folder.

```text
You are working on Haat gateway: a Personal Agent Protocol ("Poppy", draft 0.3) Company that lets
personal AI agents shop from ONDC sellers over Beckn, with the person's approval before every order
(Operations extension v2). Read README.md, docs/architecture.md, docs/limitations.md,
docs/going-live.md, docs/conformance.md and CONTRIBUTING.md before changing anything.

Goal: v0.3 items from ROADMAP.md that don't need ONDC's approval, one commit each:
1. Reconcile operations interrupted mid-confirm (good first issue 10).
2. Retail contract: add the mandatory RET10 fields ONDC's log verification asks for to
   search/select/init/confirm/status. Read ONDC-Official/ONDC-RET-Specifications on GitHub first and
   cite the file and version you used in comments. Update the mock sellers to match.
3. IGM basics: raise an issue for an order (seller unreachable, wrong item) using ONDC's IGM API,
   behind the approval gate if it has side effects.
4. An SMS OtpProvider interface implementation with a stubbed provider in tests (issue 12).

Rules:
- Erasable TypeScript only; `npm run check` must pass after every commit; no new runtime dependencies.
- Every behaviour change gets a test; security fixes get a test that fails without the fix.
- Never weaken src/poppy/session.ts, src/poppy/operations.ts or src/oauth/server.ts checks to make
  a test pass.
- After each item, run `sudo scripts/conformance/run-official-validator.sh` and keep 0 failures.
- Never call real ONDC endpoints or payment systems.
- Update docs/limitations.md, docs/going-live.md and CHANGELOG.md as items land.

Report honestly at the end: what you built, the exact `npm test` count, the validator summary, what
you could not verify, and anything in a spec you found ambiguous.
```
