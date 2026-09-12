---
covers:
  - 'feat(claude-code): report thinking tokens and the pricing basis behind each cost'
  - 'feat(client): say when a session cost is an estimate'
  - 'fix(claude-code): give the in-session DorkOS tool server its own timeout'
---

### Changed

- A session's cost now tells you how sure it is. If DorkOS has no published
  price for the model that ran, the figure says it is an estimate instead of
  standing there like a fact. A cost charged at your company's own rates says
  that too. You will see it in the cost tooltip and in the `/context` panel.
- If you export traces of your agent runs, each turn now also reports how many
  of its output tokens the model spent thinking.

### Fixed

- Lowering `MCP_TOOL_TIMEOUT` to cut off a slow outside tool server works again.
  DorkOS used to raise your value back up, because a short one would also cut
  off a tool call that was waiting on you to approve it. DorkOS now sets its own
  time limit on its own tools, so your setting is left alone and reaches the
  server you meant it for.
