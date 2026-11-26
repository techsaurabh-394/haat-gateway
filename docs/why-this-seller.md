# Why this seller?

Every suggested basket says why that seller was picked, from the comparison the gateway actually
made. Nothing is added for show.

## What is compared

1. **How many of the wanted items the seller covers.** More is better.
2. **The items total**, as a tie-break between sellers that cover the same number.

If two sellers tie on both, the one whose answer arrived first is picked, and the explanation says
it was a tie.

## What is NOT compared

Delivery fee, distance, delivery time and seller reliability. The delivery fee is only known at the
final quote, and the mock sellers send no delivery time. Every explanation ends with this list
(`why.not_compared`), in English and Hindi, so nobody reads a reason into the choice that is not there.

## Where it shows up

- `GET /api/v1/search`: `suggested_basket.why` has `reason`, `covered`, `wanted`, `sellers_compared`,
  up to 3 `alternatives` (best first, each with `versus`), `not_compared`, and ready-made `text`
  (in the request's `Accept-Language`, English by default) and `text_hi`.
- Conversations: after a search, "why this seller?", "yeh dukan kyun?" or "यही दुकान क्यों?" answers
  with the same text, and `data.why`. With no search yet it is treated as an ordinary message and no
  explanation is invented.

`reason` is one of `only_seller`, `covers_most`, `cheapest_among_equal`, `same_total_first_answer`.
`versus` is one of `covers_less`, `costs_more`, `cheaper_but_covers_less`, `same_total`.

## Example (local mock network)

```text
Kashi Kirana Store covers the most of your list (2 of 2 items) among 3 sellers.
Others: Ganga Dairy: cheaper (₹40) but only 1 of 2 items; Assi Sabzi Mandi: cheaper (₹104) but only 1 of 2 items.
Not considered: delivery fee, distance, delivery time, seller reliability.
```

The explanation carries no phone number, address or token. It is built from the offers list, which
the search response already shows.

Seller reliability scores (roadmap) will add a third input later. Until then, the text says it is not used.
