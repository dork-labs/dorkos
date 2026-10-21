---
covers:
  - 'feat(config): add the DM view experiment and the Show sessions setting (DOR-3074)'
  - 'feat(settings): read the DM view switch and add Show sessions (DOR-3074)'
  - 'feat(chat): draw a chat with one agent as a DM over its Direct chat (DOR-3074)'
  - 'feat(rooms): every door to an agent opens its DM, and its card offers Message (DOR-3074)'
  - 'fix(config): only a person turns the DM view or Show sessions on or off (DOR-3074)'
  - 'fix(chat): a DM keeps the model picker, safety readings and times, with no flash (DOR-3074)'
  - 'fix(rooms): every door falls back for non-owners, and the card works by keyboard (DOR-3074)'
  - 'fix(history): messages carry the times they were sent, never the time they were read (DOR-3074)'
---

### Added

- Try talking to an agent like a teammate. In Settings, under Experiments, turn on **Chats with one agent read like a DM**. Your chat with an agent then looks like a direct message: its face and name at the top, its replies with its face, name and time, and a message box like a channel's. Nothing the chat shows today is lost: replies still appear as they are written, and the steps and to-dos behind each reply fold into one line you can open. The Wi-Fi notice and a nearly full context still show under the box. (DOR-3074)
  - Clicking the agent anywhere opens that same chat: its row in the sidebar, Message on its card, its profile, the New menu and the agent in Cmd+K.
  - Click an agent's face, name or @mention in a channel to see its card, with what it does, what it is working on, and Message and Profile buttons. With a keyboard, press Enter on its name.
  - The top of the chat lists the channels you and the agent are both in.
- Turn on **Show sessions** on the same page to keep the model, account and context one click away. A chip at the top of the chat shows how full its context is and opens the working session behind it, exactly as chats look today. Both settings apply to everyone using this DorkOS, and only a person can change them. (DOR-3074)

### Fixed

- Codex and OpenCode chats now show when each message was sent, even after you reload the page, with a divider for each day. (DOR-3074)
