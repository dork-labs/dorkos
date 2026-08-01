---
covers:
  - 'feat(client): an answered permission request settles into the conversation as a receipt'
  - 'fix(client): answered permission requests survive the end of a turn'
---

### Added

- When your agent asks permission and you answer, the card now settles into the conversation as a receipt — a one-line record of the ask and your answer, right where it happened. Allowed and denied requests say so by name; a request nobody got to says it expired and how long it waited. Answering several at once leaves one line with the details a click away. Receipts stay put for as long as the conversation is open; reopening it later still shows only the tools, not the asks.
