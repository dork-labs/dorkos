---
covers:
  - 'feat(client): ⌘K finds your conversations, and opens on what is live (DOR-1073)'
  - 'test(e2e): ⌘K finds a conversation by title and lands in it, in a browser'
  - 'docs(client): say why ⌘K warms its corpus at boot, and make the budget test discriminate'
  - 'fix(client): an agent whose only conversation is live is no longer offered twice'
---

### Added

- **⌘K now finds your conversations.** Type a few words from a chat's title and it comes
  up, whichever agent it belongs to and whenever you last touched it. Press Enter to go
  back to it, or ⌘Enter to start a fresh chat with the same agent. Both shortcuts are
  written on the row you have highlighted, so you never have to be told about them.
- Each conversation reads the way it does in the sidebar: the agent's face, the agent's
  name, then the title — plus a small mark when the chat started somewhere other than
  with you (a scheduled run, a message from Telegram, a room), and when it last moved.

### Changed

- **Opening ⌘K without typing now shows a command center instead of a menu.** First
  **Continue** — the chats your agents are working in right now, each saying what it is
  doing ("Editing strip-state.ts…", "waiting on you"). Then **Recent** — the last things
  you were in, whether they were chats, channels or agents, with anything unread on top.
  Then **New**, for starting a chat or making an agent. Continue is simply absent when
  nothing is running, rather than an empty heading.
- Settings, Tasks, Toggle Theme and the rest are no longer listed before you type. They
  are one keystroke away: start typing and they come back.

### Notes

- ⌘K searches what things are **called** — chats, agents, channels, actions — and never
  what was said inside them. Searching your messages stays a separate thing.
