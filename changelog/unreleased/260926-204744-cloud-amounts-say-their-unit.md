---
covers:
  - 'feat(cloud-api): say which amounts are money and which are credits, serve the unit, and render both one way (DOR-2425)'
---

### Added

- `@dork-labs/cloud-api` now says, for every amount, whether it is money or credits, and the service can send the unit those amounts are in: the currency, and how many micro-units make one credit. A client can now read the scale from the service instead of assuming one. The field is optional, so a response from an older service still reads. This replaces the currency half of DOR-2212 (DOR-2425)
- The published price list can now carry each model's cache-read and cache-write rates beside its input and output rates (DOR-2163)
- A new `@dork-labs/cloud-api/display` entry gives every client one way to render a Cloud amount: a balance rounds down so it never shows credit you cannot spend, a charge rounds to the nearest whole credit and shows `<1` for a tiny one, a price is never rounded, and a credit figure can show its money value beside it that always agrees with it. It returns nothing rather than guessing when the unit is missing. The desktop app moves onto it in a later release (DOR-2425)
