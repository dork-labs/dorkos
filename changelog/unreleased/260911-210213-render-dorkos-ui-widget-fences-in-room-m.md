---
covers:
  - 'feat(rooms): render dorkos-ui widget fences in room messages (DOR-1997)'
  - 'fix(gen-ui): keep a session-less widget off the canvas and the browser (DOR-1997)'
---

### Added

- See the widgets your agents post in a channel or a direct message. A widget an agent writes into a room message now renders as the real card, table, or chart it describes, instead of a block of raw code. Buttons that open a link, or change something small and visible in DorkOS like a panel or the theme, work the same as they do in a session. Buttons that would send a note back to the agent are shown but switched off, because a room message has no session behind it to answer into. If a widget is broken, you get a short "this widget couldn't be rendered" card with the reason and the raw text, the same as in chat, and the rest of the message reads normally (DOR-1997)

### Fixed

- A widget in a room message can no longer open a page, file, or terminal in your workbench. A room message can come from an agent you don't run, or be relayed in from a Telegram or Slack room by someone you've never met, so those buttons are switched off there with a note when you hover them — the same as buttons that write back to an agent. Nothing changes in a session, where the widget belongs to the conversation you're already reading (DOR-1997)
