---
covers:
  - 'feat(connections): always list popular apps and ask how to reach them on the first connect (DOR-2421)'
---

### Added

- The Connect a service list always shows popular apps like Gmail, Slack and Notion, each with one line about what your agents can do with it. Before, it said "No matching services" until you had set up how DorkOS reaches your apps, and never said why (DOR-2421).
- The first time you connect an app, one short step asks how DorkOS should reach your apps: your own Composio key, or your own Nango server under Other ways. You only see it once. After that, Connect goes straight to sign-in (DOR-2421).
- Before an app's own sign-in page opens, one line tells you whose name it will show, for example "Google will ask you to allow Composio", so it is never a surprise (DOR-2421).

### Changed

- Telegram, Slack and Webhook are listed with the other apps and tagged Chat. Connecting one opens its own setup right away, with nothing else to set up first (DOR-2421).
