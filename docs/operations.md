# Operating Haat

Four endpoints help an operator see whether the gateway is healthy and chase stuck orders.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Liveness. The process answers. Returns only `ok` and `uptime_s`. |
| `GET /readyz` | none | Readiness. Writes and reads back a probe in the store. 200 or 503. |
| `GET /metrics` | operator token | Prometheus text format. |
| `GET /ops/overview` | operator token | Stuck operations, pending confirms, seller health (JSON). |

## Turning on /metrics and /ops/overview

Set a long random secret:

    export HAAT_OPS_TOKEN="$(openssl rand -hex 32)"

Send it as `Authorization: Bearer <token>`. Without `HAAT_OPS_TOKEN` both endpoints answer 404
(the feature is off). A missing or wrong token gets 401. The token is compared in constant time.
Serve the gateway over HTTPS in production; the token travels in a header.

## What the overview shows

- `unresolved_operations`: approved operations whose outcome is unknown (seller ACKed but no
  `on_confirm`). These answer 503 to the agent and are never retried automatically. Fields:
  operation id, action, since when, age, reason.
- `pending_confirms`: confirms sent to a seller that has not answered. Fields: transaction id,
  operation id, seller id and name, sent time, age.
- `sellers`: per seller, how many calls were answered, silent or rejected, the answer rate and the
  average answer time. Kept in memory, so it resets on restart. Bounded to 500 sellers.

The overview never contains user or owner keys, phone numbers, addresses, order contents or
tokens. A test checks this.

## Metrics

| Metric | Type | Meaning |
| --- | --- | --- |
| `haat_operations_unresolved` | gauge | Operations with an unknown outcome. Alert when above 0 for a while. |
| `haat_oldest_unresolved_seconds` | gauge | Age of the oldest one. |
| `haat_confirms_pending` | gauge | Confirms awaiting a seller answer. |
| `haat_uptime_seconds` | gauge | Seconds since start. |
| `haat_seller_calls_total{action,result}` | counter | `result` is `answered`, `silent` or `rejected`. Search fan-out is not counted. |
| `haat_seller_answer_seconds` | histogram | Seller answer time by action. |
| `haat_http_requests_total{route,status}` | counter | Route is the pattern (`/api/v1/orders/:id`), status is the class (`2xx`). |
| `haat_http_request_seconds` | histogram | Request time by route pattern. |

Labels come from fixed sets (route patterns, status classes, actions), never from raw URLs or
user input, so the number of series stays bounded. Unknown paths are grouped as `unmatched`.

## Suggested alerts

- `haat_operations_unresolved > 0` for 10 minutes: a seller never confirmed. Contact the seller or
  check the order with `status`; do not re-send confirm.
- `rate(haat_seller_calls_total{result="silent"}[15m])` high for one seller in `/ops/overview`.
- `/readyz` not 200: the store is failing.

## Limits

- Counters and seller health are in memory and reset on restart. The unresolved and pending lists
  come from the store, so they survive restarts.
- This is a JSON and text interface. There is no web dashboard yet.
