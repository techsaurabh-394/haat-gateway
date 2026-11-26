# Seller reliability

Haat keeps a short history of how each seller answered **Haat's own calls**, and shows it openly.
It is a label, not a score, and it has one small job in choosing a seller.

## What is measured

For every direct call to a seller (`select`, `init`, `confirm`, `status`, `cancel`) Haat records
whether the seller **answered**, stayed **silent** (ACKed but sent no callback in time), or
**rejected** it (NACK or a 4xx). Answers that arrive after Haat stopped waiting are counted as
`late` and shown, but they do not erase the silence that came first.

Searches are not counted: they go through the Beckn gateway to many sellers at once, so nobody can
say who stayed silent.

The label uses the seller's **last 50 calls**, so an old bad patch is forgiven and a new one is not.
A rejection is left out of the label, because it can be Haat's own bad request.

| Label | Meaning |
| --- | --- |
| `reliable` | answered 95% or more of its recent calls |
| `mixed` | 80% to under 95% |
| `unreliable` | under 80% |
| `not_enough_data` | fewer than 10 recent calls; no judgement is made |

`slow` is added when the average answer takes longer than 3 seconds.

## What it does when choosing a seller

**It only breaks an exact tie.** Sellers are compared by items covered, then items total. Only when
two sellers are equal on both does the one that answered Haat more reliably win, and the explanation
says so (`same_total_more_reliable`). An unreliable seller still wins when it covers more or costs
less. `not_enough_data` ranks with `mixed`, so a new seller is not punished.

## What it does not know

It says only that a seller answers Haat. It cannot see cancellations by the seller, product quality,
late deliveries, or what customers think. The "why this seller?" text says exactly this next to the
label. Do not read it as a rating.

## Where it shows up

- `GET /api/v1/search`: `suggested_basket.why.reliability` (and `alternatives[].reliability`).
- "Why this seller?" text, in English and Hindi, when the label is not `not_enough_data`.
- `GET /ops/overview`: per seller `reliability` and `late`, next to the counts.

## Storage

Kept in the store (`seller_stats`), so a restart with `HAAT_DB` does not wipe it. With the memory
store it is lost on restart. Bounded to 500 sellers. A failing store never breaks an order.
