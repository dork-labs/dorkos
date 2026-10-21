---
covers:
  - "feat(chat): tell a reply's work from what it said, and draw either alone (DOR-3075)"
  - "feat(chat): a DM folds each reply's work into one line, with Show work and Watch (DOR-3075)"
  - "feat(chat): a DM's right panel matches a session's, plus a Work tab (DOR-3075)"
  - 'feat(profile): beside a DM, the profile names its model, account and chats only with Show sessions (DOR-3075)'
---

### Added

- With **Chats with one agent read like a DM** turned on in Settings, under Experiments, a chat with an agent now reads like a conversation. (DOR-3075)
  - The steps behind a reply fold into one line under it, like "Worked · 6 steps · 1m 12s". Press **Show work** to see every step.
  - While the agent works, one line says what it is doing. Press **Watch** to follow along.
  - Questions and approvals still show in the chat, with their buttons.
  - The side panel has the same tabs as a chat, plus a new **Work** tab. It lists every step the agent took, one reply at a time, as it happens.
  - In a DM with more than one member, pick who the side panel is about at its top.
  - With **Show sessions** off, the agent's model, account and chat count stay out of sight, and so do the Terminal and Chat tabs. Turn it on to see them, and to open the session from the Work tab.
