---
covers:
  - 'fix(usage): keep a usage limit two sessions see in the same millisecond (DOR-2380)'
---

### Fixed

- When two sessions on one account hit a usage limit at the same moment, the app now keeps the reading that says the account is out of usage. Before, the second reading was dropped, so an account could look free when it was not (DOR-2380)
