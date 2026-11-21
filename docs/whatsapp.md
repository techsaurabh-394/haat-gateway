# WhatsApp approvals

The person gets the exact approval summary on WhatsApp and approves with one tap on a single-use
link. The approval still goes through the same gate as every other approval: same owner, latest
unexpired revision, performed at most once.

## How it works

1. A signed-in agent places an order request and gets an operation (`403 approval_required`).
2. The agent calls `POST /api/v1/operations/{id}/whatsapp` (scope `orders:write`).
3. Haat sends the summary and a link to the **verified phone of the signed-in account**. The agent
   cannot choose the number and never sees the link.
4. The person opens `/approve/<token>` (a page showing the terms) and taps **Approve**.
5. The agent repeats its original request with the `Poppy-Approval` header. It gets the same order
   back (replayed); a second order is never placed.

## Safety rules the code enforces

- Opening the link (GET) shows the terms and approves nothing. Only POST approves, so link previews
  and scanners cannot approve.
- The token is 32 random bytes; only its SHA-256 is stored. It is tied to one operation revision and
  one owner. A new revision (changed terms) makes older links useless.
- Single use: two simultaneous taps place exactly one order.
- At most 3 sends per operation; a failed send revokes its link.
- An unknown outcome (the seller's answer is late) shows "in progress", and confirm is never resent.

## What you need to go live (not included here)

This repository runs and tests everything against a mock provider. The real
`WhatsAppCloudProvider` is written to Meta's documented request shape and is covered by a test that
checks the request, but it has **not been run against the live API**.

To use it you need:
- a Meta business account and a WhatsApp Business phone number;
- a message template approved by Meta, with two body variables: `{{1}}` the summary and `{{2}}` the link;
- the environment variables below.

```
HAAT_WHATSAPP_TOKEN=...            # permanent access token
HAAT_WHATSAPP_PHONE_NUMBER_ID=...  # the sending number's id
HAAT_WHATSAPP_TEMPLATE=...         # approved template name
HAAT_WHATSAPP_LANGUAGE=en          # template language code (optional)
```

Without `HAAT_WHATSAPP_TOKEN`, the mock network prints messages to the console and ONDC mode has
no WhatsApp endpoints. Sign-in also needs a real OTP provider outside dev mode.
