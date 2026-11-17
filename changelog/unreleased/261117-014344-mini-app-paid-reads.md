---
covers:
  - "fix(connectors): a mini app's paid reads go through the monthly spend limit, and its access page says Spends money (DOR-4575)"
---

### Changed

- A mini app's reads from an app that charges per use now count against your monthly spending limit, the same limit agents use. With no limit set, a mini app can't run them.
- When a mini app asks to read an app that charges per use, its request and its page say "Spends money".
- An app is recognized as one that charges per use however its name is written, like "Perplexity AI" or "perplexity_ai".
