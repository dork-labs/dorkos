---
covers:
  - 'fix(rooms): a channel says its name once (DOR-583)'
  - 'fix(rooms): the browser tab names the room you are reading (DOR-583)'
  - 'fix(rooms): channels sort by name, so the list stops moving (DOR-583)'
  - 'fix(rooms): keep the unread badge live where the sidebar is not (DOR-583)'
  - 'fix(rooms): an unread row names its channel once too (DOR-583)'
  - 'fix(rooms): keep the spoken channel name out of copy and find (DOR-583)'
  - 'fix(chat): the waiting bell survives navigating to a room (DOR-583)'
---

### Fixed

- Channels are named once instead of twice. Every channel showed up as
  `# #general` — in the sidebar and at the top of the room — because the `#`
  was drawn twice. Now you see it once, and a screen reader still hears the
  full `#general` (DOR-583)
- Your browser tab says which conversation you are reading, and how many are
  waiting. It used to show the folder your last chat was in, so a tab left in
  the background could never tell you a channel had new messages. Now it reads
  `#general`, with a count in front like `(3)` when three conversations have
  something new — and that count keeps up even on a phone, where the sidebar
  is tucked away (DOR-583)
- Channels stay put in the sidebar. They are listed alphabetically now, so a
  quiet channel no longer sinks to the bottom and the list stops rearranging
  itself while you are using it. Direct messages still show the most recent
  first, which is what you want there (DOR-583)
