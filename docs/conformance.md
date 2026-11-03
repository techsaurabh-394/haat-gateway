# Conformance with the Personal Agent Protocol

Haat is checked with the **official Company validator** from the Personal Agent Protocol repository (`kit/company/validate`), not just with its own tests. The validator acts as a test Personal Agent, quotes the spec on every check, and runs against a live deployment.

## Latest run

Spec repository commit `1de1990` (30 October 2026), draft 0.3, over real HTTPS with a local certificate authority:

| Milestone | Passed | Failed | Warnings | Skipped |
| --- | --- | --- | --- | --- |
| 1. Foundation (discovery, Sessions, delegations) | 59 | 0 | 0 | 3 |
| 2. Interfaces (APIs, conversations, streaming, feedback) | 39 | 0 | 0 | 17 |
| 3. Sign-in and accounts | 0 | 0 | 0 | 2 |
| 4. Extensions (Operations) | 1 | 0 | 0 | 0 |

Every skipped check is for something Haat does not offer: Device Sign-In, Mediated Sign-In, MCP servers, browser join, several domains sharing an issuer, and a feedback alternative (Haat answers feedback with 202). Full output: [conformance/official-validator-results.txt](conformance/official-validator-results.txt).

**What the validator cannot check.** It cannot play a person on a sign-in page, so the interactive Direct Sign-In flow (PKCE, consent, partial scopes, decline, `iss`) is covered by Haat's own tests in `test/signin.test.ts`, not by the validator.

## What the first runs found

The first run failed one check and warned on another. Both were real:

1. Haat refused every conversation from agents without the Operations extension. Spec 3.3 only allows refusing a request that is handled *only* with an extension. Chatting and searching don't need it, so conversations are now open to every agent; only the ordering step explains that it needs Operations, and no operation is ever sent to such an agent.
2. Feedback was accepted without a Session header. That is allowed, but the spec recommends verifying it, so Haat now requires it.
3. A later run found that a Direct Conversation request must check its parent first (`conversation_not_found`, `conversation_closed`) before saying the feature isn't supported.

## Rerun it

```bash
sudo scripts/conformance/run-official-validator.sh          # all milestones
sudo scripts/conformance/run-official-validator.sh foundation
```

It needs root for port 443 and an `/etc/hosts` entry (`haat.localhost`, `agent.localhost`), plus `git`, `openssl` and Node 22.18+. CI runs it on every push (the `conformance` job).
