---
covers:
  - 'feat(client): ⌘K can search inside one agent or channel, and the cockpit keeps one memory of what you use (P3.3, DOR-1075)'
---

### Added

- ⌘K can now search **inside** one agent or one channel. Type `@` or `#`, land on the one you
  want, and press Tab — it becomes a chip in the search box, and what you type next only looks at
  that agent's or that channel's conversations. Backspace with the cursor at the start puts the
  chip down again and keeps what you typed. There is no search syntax to memorise: the chip is on
  screen the whole time, so you can always see what you are looking inside (DOR-1075).

### Changed

- ⌘K now remembers how often you open a conversation or a channel, not just an agent. It used to
  keep a separate note of the agents you use, so a channel you live in could never rank as highly
  as an agent you open every day. There is one memory for all three of them now, and the sidebar
  and ⌘K both write to it — so it no longer matters which door you came through. Your existing
  agent history moves across, so the agents you already reach for stay where they are (DOR-1075).
- The sidebar's Today list puts a conversation where your own attention left it: writing in one
  counts, not just opening it. So a conversation you typed in this morning stays near the top even
  if you opened something else since. When we cannot tell when you last wrote — some agent
  runtimes do not report it — the order falls back to when you last opened it, rather than
  guessing (DOR-1081).
