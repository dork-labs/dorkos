---
covers:
  - "fix(server): read the context window of the chat's own model"
---

### Fixed

- Chats on a model with a one-million-token memory, like Opus 5.5 (1M) or Sonnet 5, showed a 200k limit. The context meter now shows the real size. Agents in those chats are no longer told their conversation is nearly full, or nudged to summarize it, at a fifth of the real limit.
