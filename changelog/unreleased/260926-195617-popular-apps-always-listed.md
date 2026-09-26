---
covers:
  - 'feat(connections): always list popular apps and ask how to reach them on the first connect (DOR-2421)'
  - 'fix(connections): keep the first connect honest when a way to reach apps is down or cannot sign in (DOR-2421)'
  - 'fix(connections): tighten first-connect copy, refusal order and step layout (DOR-2421)'
---

### Added

- The Connect a service list always shows popular apps like Gmail, Slack and Notion, each with one line about what your agents can do with it. Before, it said "No matching services" until you had set up how DorkOS reaches your apps, and never said why (DOR-2421).
- When nothing you have set up can reach an app yet, connecting it starts with one short step that asks how DorkOS should reach your apps: your own Composio key, or your own Nango server under Other ways. If something is set up but not working, the step says so in one line. Once a way works, Connect goes straight to sign-in (DOR-2421).
- Before an app's own sign-in page opens, one line tells you whose name it will show, for example "Google will ask you to allow Composio", so it is never a surprise (DOR-2421).

### Changed

- Telegram, Slack and Webhook are listed with the other apps and tagged Chat. Connecting one opens its own setup right away, with nothing else to set up first (DOR-2421).
