---
covers:
  - "fix(claude-code): report each turn's own usage, not the SDK's running total"
  - 'fix(claude-code): trust DorkOS tools by server provenance, not by name'
---

### Added

- DorkOS now offers Anthropic's newest model, Opus 5.5. Choose "Opus" in the model menu to use it. On some accounts the row reads "Opus (1M context)".

### Note for people upgrading

- Sessions and agents already set to Opus, or to Default on an account whose default is Opus, move to Opus 5.5 on their next message. Opus 5.5 is priced differently from the Opus it replaces, so what a turn costs can change. To stay on the older model, set its full model name on the agent.

### Fixed

- A session's cost total stays correct after you resume it. Before, it started again from zero whenever the session restarted.
- Each turn's token and cost figures in your own traces now cover that turn alone. Before, from the second turn on, they counted the whole session so far.
- A tool from another server that borrows DorkOS's name no longer skips the approval prompt. DorkOS now checks which server actually runs the tool, not just its name.
