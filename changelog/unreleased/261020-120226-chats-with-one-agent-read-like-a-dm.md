---
covers:
  - 'feat(config): add the DM view experiment and the Show sessions setting (DOR-3074)'
  - 'feat(settings): read the DM view switch and add Show sessions (DOR-3074)'
  - 'feat(chat): draw a chat with one agent as a DM over its Direct chat (DOR-3074)'
  - 'feat(rooms): every door to an agent opens its DM, and its card offers Message (DOR-3074)'
---

### Added

- Try talking to an agent like a teammate. In Settings, under Experiments, turn on **Chats with one agent read like a DM**. Your chat with an agent then looks like a direct message: its face and name at the top, its replies with its face, name and time, and a message box like a channel's. Everything the chat shows today stays, from replies as they are written to tool steps and to-dos. (DOR-3074)
  - Clicking the agent anywhere opens that same chat: its row in the sidebar, Message on its card, its profile, the New menu and the agent in Cmd+K.
  - Click an agent's face, name or @mention in a channel to see its card, with what it does, what it is working on, and Message and Profile buttons.
  - The top of the chat lists the channels you and the agent are both in.
  - An agent that only answers when mentioned in a channel answers every message here, no @ needed.
- Turn on **Show sessions** on the same page to keep the model, account and context one click away. A chip at the top of the chat shows how full its context is and opens the working session behind it, exactly as chats look today. (DOR-3074)
