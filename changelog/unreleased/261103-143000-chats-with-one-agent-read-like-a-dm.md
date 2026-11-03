---
covers:
  - 'feat(chat): a chat with one agent reads like a DM by default (DOR-3074)'
  - "fix(chat): a DM never flashes the session's bar and tabs while the setting loads (DOR-3074)"
---

### Changed

- A chat with one agent now reads like a direct message: the agent's face and name, its replies, and a message box like a channel's. Every way to reach an agent opens this same chat. Upgrading turns it on once, unless you already switched it yourself. To go back, turn off **Chats with one agent read like a DM** in Settings → Advanced → Experiments.
- The model, account and context move behind **Show sessions**, in the same place. If you opened a chat other than an agent's main one in the last 30 days, Show sessions is already on for you.
