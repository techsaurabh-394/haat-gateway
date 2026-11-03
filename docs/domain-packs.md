# Domain packs

A domain pack teaches Haat one ONDC domain. It is data, not code, so you can add or improve one without writing TypeScript.

```
packs/
  ondc-ret10-grocery/
    pack.json      # what the domain is
    lexicon.json   # how people ask for things in it
```

## pack.json

```json
{
  "id": "ondc-ret10-grocery",
  "name": "Grocery",
  "domain": "ONDC:RET10",
  "description": "Kirana and grocery: staples, dairy, vegetables, household items.",
  "lexicon": "lexicon.json",
  "quote_ttl_sec": 600,
  "maintainers": ["your-github-username"]
}
```

- `domain` must look like `ONDC:RET10`. ONDC retail domains include RET10 (grocery), RET11 (food and beverage), RET12 (fashion), RET13 (beauty and personal care), RET14 (electronics), RET15 (appliances), RET16 (home and kitchen), RET18 (health and wellness). Check the current list in ONDC's documentation before adding one.
- `quote_ttl_sec` is how long an approval stays valid. Fresh food needs shorter holds than staples.

## lexicon.json

See [lexicon.md](lexicon.md) for the format and rules.

## Adding a pack

1. Copy `packs/_template` to `packs/ondc-retXX-yourdomain`.
2. Fill in `pack.json` and at least 10 lexicon entries.
3. Run `npm test`. `test/packs.test.ts` validates every pack and rejects a variant claimed by two products.
4. Open a pull request using the "New domain pack" issue form first, so others can help.

Today the gateway routes orders to `ONDC:RET10`; making the domain selectable per request is tracked in the good first issues.
