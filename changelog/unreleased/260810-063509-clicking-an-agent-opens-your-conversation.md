---
covers:
  - 'feat(client): clicking an agent opens your conversation, and the session switcher holds the rest (P2.6, DOR-1071)'
  - 'fix(client): the "N live" chip counts what the switcher shows, and lands where it reserved (P2.6 review, DOR-1071)'
---

### Changed

- Clicking an agent in the sidebar now opens the conversation you were having with it,
  the way clicking a person in a chat app opens your messages with them. It used to
  unfold a little panel underneath showing three of that agent's sessions, which meant
  two clicks to get anywhere and no way to see the other eleven. That panel is gone
  (DOR-1071)

### Added

- **The session switcher.** When an agent has more than one conversation going at once,
  its sidebar row shows a small "2 live" chip. Click it — or find the agent in ⌘K and
  pick "Browse sessions…" — and you get every conversation that agent has, in three
  groups: the ones running right now, each saying what it is doing ("Editing
  RoomRow.tsx…"); the ones you finished, each with the last thing that happened in it;
  and everything that started without you — scheduled runs, messages from Telegram —
  tucked away until you ask for them. The one you have open is marked. Press Enter to
  jump into a conversation, ⌘Enter to start a fresh one, or Shift+Enter to branch off
  a copy and leave the original alone. It opens as a panel on a computer and slides up
  from the bottom on a phone (DOR-1071)
