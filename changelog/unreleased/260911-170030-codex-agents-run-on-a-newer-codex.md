---
covers:
  - 'chore(codex): bump @openai/codex-sdk and CLI to 0.154.0'
---

### Changed

- Codex agents now run on Codex 0.154.0, which carries upstream fixes for connected tool servers and for picking up skill and plugin changes in a session that is already open. Context readings refresh themselves within a few minutes of the update. If you never picked a model for an agent, Codex now chooses your account's default, which may not be the model it picked before.
