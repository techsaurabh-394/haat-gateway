# Load test

`npm run loadtest` runs the whole order flow many times at once against the **local mock network**
and prints measured latencies. It also checks the safety claim under load.

```bash
npm run loadtest                                           # 20 workers, 200 orders
npm run loadtest -- --workers 50 --orders 1000 --search-window 500
npm run loadtest -- --json                                 # machine-readable
```

Each worker does: search in Hinglish, ask to order (the gate answers `403 approval_required`),
approve and place the order, then retry the same approval (which must replay the same order).

## What it checks

- Every order id is distinct (no order was issued twice).
- Every retried approval returned the same order.
- The three mock sellers, counted independently through `/_debug/orders`, received exactly as many
  confirms as orders the gateway reported. A gateway that lost or doubled an order would show up here.

The script exits with code 1 on any failure or mismatch. `test/loadtest.test.ts` runs a small version in CI.

## Measured results

Apple M1 (8 cores), Node 22.19, 26 November 2026. One process runs the gateway, the registry, the
Beckn gateway, three mock sellers and the load generator, over loopback HTTP, with an in-memory
store. 1,000 orders each. Latencies in milliseconds.

| Setting | Orders placed | Duplicates | Full flows per second |
| --- | --- | --- | --- |
| 10 workers, 100 ms search window | 1000 / 1000 | 0 | 48.2 |
| 50 workers, 500 ms search window | 1000 / 1000 | 0 | 78.2 |

| Step (10 workers, 100 ms window) | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| search | 102 | 104.5 | 115.5 | 154.9 |
| ask to order (gate answers 403) | 66.2 | 72.3 | 92 | 147.9 |
| place approved order | 34.3 | 40 | 47 | 83.8 |
| retry the same approval | 1.6 | 5 | 7.9 | 73.6 |
| whole flow | 204.8 | 217.6 | 265.2 | 311.9 |

| Step (50 workers, 500 ms window) | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| search | 503.3 | 533.6 | 682 | 712.6 |
| ask to order (gate answers 403) | 69.9 | 110.7 | 162.8 | 189.7 |
| place approved order | 36.2 | 71.6 | 97.6 | 111.5 |
| retry the same approval | 2.5 | 17.5 | 36.6 | 44.4 |
| whole flow | 611.9 | 726.2 | 943.5 | 972.3 |

Reading them:

- **Search is dominated by the search window you choose.** The gateway waits that long for sellers'
  answers (`searchWindowMs`), so p50 search is about the window. It is a setting, not gateway work.
- **A retried approval costs 2 to 20 ms**, because it is a store lookup and no seller is contacted.
- "Ask to order" and "place" include the signed Beckn `select`/`init` and `confirm` round trips to
  the mock sellers, which answer instantly. Real sellers will be slower, and that time is theirs.

## What this does not show

- Nothing here touches real ONDC sellers, a real network, TLS, a database on disk, or a deployed server.
  The numbers are the gateway's own overhead with instant mock sellers.
- The load generator shares the CPU with the system under test, so absolute numbers are pessimistic
  for the gateway and say nothing about other hardware.
- With 50 workers and a short (100 ms) search window, about 3% of searches returned no basket, because
  the mock sellers' answers arrived after the window closed. Orders that did go through were still
  placed exactly once. A longer window (500 ms) gave 0 failures. On a busy host, choose the window with that in mind.

## Two settings the benchmark changes

- **Rate limit.** The gateway allows 120 requests a minute per client by default. One load-test
  agent is one client, so the script raises the limit. `--rate-limit 120` shows the default limiter
  answering `429 rate_limited`; throttled runs still never double an order (tested).
- **Stock.** Mock sellers hold 15 to 40 units per item and correctly refuse orders once something
  sells out (`409 ... out of stock`). The script multiplies stock by 1000 through the
  `stockMultiplier` test option, otherwise it would measure inventory rather than the gateway.
