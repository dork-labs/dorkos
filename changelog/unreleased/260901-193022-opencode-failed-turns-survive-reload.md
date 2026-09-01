---
covers:
  - 'fix(server): OpenCode turns that failed no longer vanish when you reopen the chat (DOR-1666)'
---

### Fixed

- When an OpenCode turn failed, reopening the chat used to show your question and nothing after it. The failure is now there where it happened, with the provider's own words, and a "Fix sign-in" button when the reason was an expired or revoked sign-in (DOR-1666)
