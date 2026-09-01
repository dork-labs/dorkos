---
covers:
  - 'fix(client,server): links in error messages, and no more bogus API-key log lines'
---

### Fixed

- Links in error messages are now clickable. When an agent fails and the provider's message points you somewhere — "add credits at ..." — that address is a real link you can open, not text to retype. The same goes for tunnel, marketplace, connector and page errors. (DOR-1661)
- Errors no longer hide what actually went wrong. A failed turn could show "An error occurred during execution." in place of the real explanation, and a sign-in failure could throw the provider's own message away entirely. Now the real explanation is what you see — and where our own wording already explains the failure, the provider's exact words are kept under Details rather than dropped. (DOR-1661)
- Quieter server log. Every time your agent reached for a DorkOS tool, the log gained a bogus "Invalid API key" error — around four per turn, burying the real problems. They are gone; genuine key failures still show up. (DOR-1661)
