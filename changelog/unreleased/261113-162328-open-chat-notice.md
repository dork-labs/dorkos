---
covers:
  - 'fix(relay): an open Telegram or Slack chat says anyone can message it, and comes back limited when turned on (DOR-3859)'
  - 'fix(relay): turning on a chat that is already on leaves its DM policy alone (DOR-3859)'
  - 'fix(client): a chat limited to an empty list says no one can message it yet (DOR-3859)'
  - 'fix(client): the empty-list notice says it keeps the owner out too (DOR-3859)'
  - 'fix(client): the empty-list note is calm, and Add people opens at the list (DOR-3859)'
---

### Fixed

- An older Telegram or Slack connection that anyone can message now says so in Connections, and stays that way until you act. One click limits it to people you list. (DOR-3859)
- Turning a Telegram or Slack connection back on now limits it to the people you list. If nobody is on the list yet, Connections says so and lets you add people. (DOR-3859)
