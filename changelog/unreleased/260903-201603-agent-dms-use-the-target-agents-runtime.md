---
covers:
  - "fix(relay,server): an agent DM'd by another agent answers on its own runtime (DOR-1627)"
  - 'fix(relay,server): say when a runtime is substituted, and stop overclaiming ADR-0255 (DOR-1627)'
---

### Fixed

- When one agent messages another directly, the agent that answers now runs on the AI tool it is set up to use. A Codex agent used to reply through Claude Code — under its own name — because a direct agent-to-agent message never said which tool to use. Messages arriving from Telegram and Slack already worked this way (DOR-1627)
- If an agent is set to use an AI tool this copy of DorkOS did not start, another one answers for it, as before — but the server log now says so, naming the agent, the tool it asked for, and the one that replied instead. It used to happen silently (DOR-1627)
