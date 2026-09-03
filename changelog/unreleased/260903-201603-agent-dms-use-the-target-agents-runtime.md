---
covers:
  - "fix(relay,server): an agent DM'd by another agent answers on its own runtime (DOR-1627)"
---

### Fixed

- When one agent messages another directly, the agent that answers now runs on the AI tool it is set up to use. A Codex agent used to reply through Claude Code — under its own name — because a direct agent-to-agent message never said which tool to use. Messages arriving from Telegram and Slack already worked this way (DOR-1627)
