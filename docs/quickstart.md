# Quickstart and API

## Requirements

Node.js 22.18 or newer. That release runs TypeScript files directly, so there is no build step. Check with `node --version`.

## Run

```bash
npm install          # TypeScript and Node types, for `npm run typecheck` only
npm run demo         # full story, you approve in the terminal
npm run demo -- --yes
npm start            # gateway on http://127.0.0.1:8080 plus the mock network, until Ctrl+C
npm test             # 126 tests
npm run lint
npm run check        # typecheck + lint + tests (what CI runs)
npm run serve        # production entry (src/main.ts), configured by environment variables
docker compose up --build
```

Environment variables: see `.env.example`. The most useful: `HAAT_DB` (a SQLite file; without it state is in memory and lost on restart), `HAAT_PORT`, `HAAT_PUBLIC_URL`, and `HAAT_LOG` (`debug`, `info`, `warn`, `error`, `silent`).

## Talking to the gateway

Every API and conversation request needs a `Poppy-Session` header: a JWT the Personal Agent signs for that exact request (Poppy draft 0.3, section 5.2). Plain `curl` can't make one, so use the reference agent in `agent/personal-agent.ts`:

```ts
import { PersonalAgent } from './agent/personal-agent.ts';

const agent = await new PersonalAgent({ name: 'My agent' }).start(); // serves agent.json + jwks.json
const company = await agent.discover('http://127.0.0.1:8080');
const sid = agent.newSession();

const search = await agent.call(company, sid, 'GET', '/api/v1/search?q=' + encodeURIComponent('2 kilo atta aur 1 litre doodh'));
const b = search.body.suggested_basket;

const order = await agent.callWithApproval(company, sid, 'POST', '/api/v1/orders', {
  bpp_id: b.bpp_id,
  provider_id: b.provider_id,
  items: b.items.map((i) => ({ id: i.id, count: i.count })),
  delivery: { name: 'Asha', phone: '9876543210', address: { city: 'Varanasi', state: 'Uttar Pradesh', area_code: '221005' } },
}, async (op) => {
  console.log(op.summary);          // show this to the person
  return true;                      // only if they said yes
});
```

## Signing in

```ts
import { personSignsIn } from './agent/personal-agent.ts';

// In real use the person opens this URL in their browser. personSignsIn plays that part locally.
await agent.signIn(company, ['orders:read', 'orders:write', 'addresses'], (url) =>
  personSignsIn(url, { phone: '9876543210', otp: '123456' }), // the development code; never in production
);
await agent.call(company, sid, 'GET', '/api/v1/orders', { signedIn: true });
await agent.signOut(company);
```

Signed in, orders belong to the account (visible from every Session and agent of that person), and `delivery_address_id` can replace `delivery` when ordering.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /.well-known/poppy.json` | Discovery document (draft 0.3) |
| `GET /.well-known/oauth-protected-resource` | `404`: no OAuth issuer, signed-out Sessions only |
| `GET /openapi.json` | OpenAPI 3.1 description of the API |
| `GET /api/v1/search?q=…&city=std:0542` | Parse the list, search the network, suggest a single-seller basket |
| `POST /api/v1/orders` | Place an order. First answer: `403 approval_required` with an operation |
| `GET /api/v1/orders` | This User's orders |
| `GET /api/v1/orders/{id}` | Live status from the seller |
| `POST /api/v1/orders/{id}/cancel` | Cancel, also behind approval |
| `POST /poppy/conversations` | Start a conversation with the Company Agent |
| `POST /poppy/conversations/{id}/messages` | Send a message (`?wait=10` holds for the reply) |
| `GET /poppy/conversations/{id}/events` | Read events (`cursor`, `wait`) |
| `POST /poppy/conversations/{id}/handoff` | Ask for a person (none available yet; says so) |
| `POST /poppy/conversations/{id}/close` | Close |
| `POST /beckn/on_*` | Signed callbacks from sellers |
| `GET /health` | Liveness and loaded packs |
| `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server` | Sign-in discovery |
| `GET`, `POST /oauth/authorize`; `POST /oauth/token`; `POST /oauth/revoke` | Direct Sign-In, tokens, sign-out |
| `GET`, `POST /api/v1/account/addresses`; `DELETE /api/v1/account/addresses/{id}` | Saved addresses (scope `addresses`) |
| `GET /poppy/excluded-tasks.json`, `POST /poppy/feedback` | Task coverage (section 9) |
| `GET /ondc-site-verification.html`, `POST {callback}/on_subscribe` | ONDC onboarding (ONDC mode) |

## Errors you will see

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_session` | Session header missing or failed verification; `error_description` says which check |
| 401 | `invalid_token` (in `WWW-Authenticate`) | The access token is unknown, expired or revoked: refresh, or continue signed out |
| 401 | no error code | The request needs the account: sign in with the `scope` in the challenge |
| 403 | `insufficient_scope` | The token lacks a scope; sign in again for it |
| 403 | `approval_required` | Show `operation.summary`, then repeat the same request with `Poppy-Approval` |
| 403 | `extension_required` | The agent's client metadata does not list `operations` version `2` |
| 404 | `unknown_seller`, `order_not_found` | Seller not in the registry, or the order belongs to another User |
| 409 | `seller_<code>` | The seller refused (out of stock `40002`, too late to cancel `50001`) |
| 409 | `message_id_conflict`, `conversation_closed` | Conversation rules (Poppy 8.3, 8.12) |
| 400 / 410 | `invalid_cursor` / `cursor_expired` | A cursor from elsewhere, or for events no longer kept (8.13) |
| 429 | `rate_limited` | Wait for `Retry-After` |
| 503 | `operation_in_progress` | The outcome is not known yet; send the **same** approval again after `Retry-After` |
