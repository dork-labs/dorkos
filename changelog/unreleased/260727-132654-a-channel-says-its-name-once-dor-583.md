---
covers:
  - 'fix(rooms): a channel says its name once (DOR-583)'
  - 'fix(rooms): the browser tab names the room you are reading (DOR-583)'
  - 'fix(rooms): channels sort by name, so the list stops moving (DOR-583)'
---

### Fixed

- Channels are named once instead of twice. Every channel showed up as
  `# #general` — in the sidebar and at the top of the room — because the `#`
  was drawn twice. Now you see it once (DOR-583)
- Your browser tab says which conversation you are reading, and how many are
  waiting. It used to show the folder your last chat was in, so a tab left in
  the background could never tell you a channel had new messages. Now it reads
  `#general`, with a count in front like `(3)` when three conversations have
  something new (DOR-583)
- Channels stay put in the sidebar. They are listed alphabetically now, so a
  quiet channel no longer sinks to the bottom and the list stops rearranging
  itself while you are using it. Direct messages still show the most recent
  first, which is what you want there (DOR-583)
