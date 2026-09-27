---
covers:
  - 'feat(server): let agents start a session on a named account with session_start (DOR-2383)'
---

### Added

- Agents can now start a new session of their own with the `session_start` tool. The new session always runs as the agent that asked for it, never as another agent. Each one shows up in Activity, with the agent that started it, the folder it works in, and the account it runs on. An agent can pick a Claude account only after Flow is set up to say which accounts agents may use. A session an agent starts can never turn off approval prompts, and at most 8 of them run at once. (DOR-2383)
