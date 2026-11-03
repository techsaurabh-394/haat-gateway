# Going live on ONDC

Haat has only placed orders on the mock network in this repository. This page lists exactly what is needed to go further, and which steps only the owner can do.

Sources: ONDC-Official/developer-docs, `registry/Onboarding of Participants.md`, and ONDC-Official/reference-implementations, `utilities/on_subscibe-service` (both read on 1 November 2026). ONDC's **staging registry is decommissioned**; start in **pre-production**.

## 1. Things only you can do

1. A legal entity, GST and PAN details, and an authorised signatory.
2. A domain you control: it becomes your `subscriber_id` (for example `haat.example.in`).
3. Get that `subscriber_id` **whitelisted** for pre-production on ONDC's Network Participant portal.
4. Ask ONDC whether an agent-facing gateway is acceptable as a buyer app, and what it means for consent, grievance handling (IGM) and responsibility for agent-placed orders. **This is unverified.**

## 2. Keys and files (Haat does this)

```bash
npm run ondc:keygen -- --subscriber-id haat.example.in
```

This writes `.ondc/` (git-ignored, private files mode 0600):

- `keys.json` and `haat.env`: an Ed25519 signing pair and an X25519 encryption pair in ONDC's formats, a `request_id`, and every environment variable Haat needs.
- `ondc-site-verification.html`: the `request_id` signed with Ed25519, no hashing, as ONDC requires. Haat also serves it itself.
- `subscribe.template.json`: a `/subscribe` body for `ops_no: 1` (buyer app). **Fill in the `FILL_IN` fields and check it against ONDC's SwaggerHub spec ("ONDC-Registry-Onboarding") before sending.** The field names follow ONDC's examples but were not checked against SwaggerHub.

## 3. Deploy

Run Haat at `https://<subscriber_id>` with `.ondc/haat.env` (Docker: `docker run --env-file .ondc/haat.env -v haat-data:/data -p 443:8080 ...` behind TLS). In ONDC mode Haat serves:

- `GET /ondc-site-verification.html`
- `POST <callback_path>/on_subscribe`: decrypts the registry's challenge with AES-256-ECB, key = X25519(your private key, ONDC's public key). ONDC's pre-prod and prod registry keys are built in (`src/ondc/onboarding.ts`).
- `POST /beckn/on_*`: signed seller callbacks.

## 4. Subscribe

Send the completed template to `https://preprod.registry.ondc.org/ondc/subscribe` yourself (ONDC limits `/subscribe` to 10 requests per minute). The registry checks the payload, fetches the verification page, and calls `on_subscribe`. Success is an `ACK`. Common failures in ONDC's FAQ: domain not whitelisted, signature on the page not matching, or `on_subscribe` decryption failing.

## 5. After subscribing

- Lookups switch to ONDC's signed `/v2.0/lookup` automatically in ONDC mode.
- Get the Beckn gateway URL from ONDC and set `ONDC_GATEWAY_URL`.
- Implement the retail contract fields ONDC's log verification asks for, then complete pre-production testing and certification before production.
- Payments: Haat uses pay-on-delivery collected by the seller. Prepaid flows involve settlement rules and possibly regulatory requirements for whoever collects.
- Sign-in: wire a real SMS provider into `OtpProvider`, or keep `HAAT_SIGN_IN=off` (guest orders still work).

## What carries over unchanged

The approval gate, Session verification, sign-in, the lexicon and basket logic, storage, and Beckn signing are network-independent, and have been tested and validated before any of the steps above.
