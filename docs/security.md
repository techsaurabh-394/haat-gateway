# Security model

Haat sits between AI agents and real purchases, so its first job is to make wrong purchases hard.

## Threats and defences

| Threat | Defence | Where |
| --- | --- | --- |
| Someone impersonates an agent | Session JWT signed with a delegated key that the agent's published JWKS vouches for; `aud`, `htm`, `htu`, `iat` checks | `src/poppy/session.ts` |
| A captured request is replayed | `jti` replay cache within the `iat` window; JWTs are bound to method and URL | same |
| Agent fetches pointed at internal services (SSRF) | HTTPS only, no loopback, private or link-local hosts unless dev mode is on; no redirects when fetching client metadata; size and time limits | `src/poppy/url-policy.ts` |
| An agent buys without asking | Every order and cancellation goes through the Operations v2 gate; agents that don't support it get `extension_required` | `src/poppy/operations.ts`, `src/gateway.ts` |
| Approval reused for different terms | The approval must name a revision whose cart fingerprint matches the request exactly; otherwise a **new** revision is returned and nothing runs | same |
| Double orders from retries or races | At most once per operation; concurrent approvals get `503`; repeated approvals replay the first response | same |
| A prompt-injected agent changes the seller URL | Seller URLs come only from the registry | `src/commerce/service.ts` |
| Forged seller callbacks | Ed25519 signature verified against the registry key; signer must be `context.bpp_id`; unknown message IDs are dropped | `src/beckn/bap.ts` |
| One user reads another's orders or conversations | Orders and conversations are keyed by agent `client_id` + pairwise User ID | `src/commerce/service.ts`, `src/poppy/conversations.ts` |
| Tokens stolen or replayed | Opaque tokens stored hashed; access tokens bound to the client (`ath` in the Session JWT and same-client check); one account per Session; refresh tokens revocable | `src/oauth/server.ts`, `src/poppy/session.ts` |
| Sign-in response swapped or redirected | PKCE S256 only; exact `redirect_uri`; `iss` on every redirect; one-time codes; CSRF cookie on the consent form; errors shown on the page, never redirected to unverified URIs | `src/oauth/server.ts` |
| Client impersonation at the token endpoint | `private_key_jwt` only, `aud` must be the issuer as a string, short lifetime, `jti` replay rejected | same |
| More access than the person approved | Never more scopes than requested; the person can untick scopes; scopes enforced on every account endpoint | same, `src/gateway.ts` |
| Double orders after a crash | Operation state is saved before the action; an interrupted one answers 503 forever rather than run again | `src/poppy/operations.ts`, `src/store/kv.ts` |
| Storage exhaustion | Every namespace has a cap; operations refuse new entries when full instead of evicting | `src/store/kv.ts` |
| Personal data leaks into logs | Summaries mask phone numbers; logs are off by default (`HAAT_LOG=warn`) | `src/commerce/service.ts` |

## What an approval does and doesn't prove

Following Operations section 8.1: an approval proves that a specific agent, in a specific Session, *stated* that the person approved a specific revision. It can't prove the person saw it. A Company can revoke agents that lie. Signed user approvals are an open topic in the Poppy spec.

## Not yet covered

- DNS-based SSRF: a public hostname that resolves to a private address is not caught (no DNS pre-resolution yet).
- The development OTP provider must never run in production; Haat refuses to start sign-in without a real provider outside dev mode.
- Mock sellers trust the registry over plain HTTP in dev mode.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Please don't open public issues for vulnerabilities.
