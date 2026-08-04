---
covers:
  - 'feat(client): Connections is the outside-world umbrella — rename family + chat-type relabel (DOR-859)'
  - 'fix(relay): plain, Slack-qualified channel labels in the Slack setup form (DOR-859)'
  - 'fix(server): channel-origin session badge reads "Connection", retiring "Integration" (DOR-859)'
---

### Changed

- Everything that links your agents to the outside world now lives under one word: Connections. The session badge, the per-agent settings, the session panel, and the add and edit dialogs all say "Connection" now, instead of the old mix of "Integration", "Connector", and "Adapter".
- When you filter which chats reach an agent, the field reads in plain language: "Chat type", with options like "Direct message" and "Broadcast channel".
- The Slack setup form names Slack directly ("Slack channel settings", "respond in Slack channels?"), so its channels never get confused with your Channels list.

### Added

- The getting-started card has a new "Connect a service" row that takes you straight to the Accounts area of the Connections page.
