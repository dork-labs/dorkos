---
covers:
  - 'fix(relay,server): an agent messaged over Relay answers on its own model (DOR-1344)'
  - 'fix(relay,server): review fixes — settings merge per key, chat-created sessions, the manifest is the agent (DOR-1344)'
---

### Fixed

- Agents you message through Relay now answer with the model you set for them, whether the message comes from another agent or from a chat app like Telegram or Slack. An agent pinned to a fast, cheap model was quietly answering on whatever the runtime picked instead — the same agent already used your setting in channels and in chat. A conversation you have already changed the model on keeps your choice. (DOR-1344)
