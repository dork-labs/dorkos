---
covers:
  - 'feat(client): the sidebar Today zone is what you were doing, in the order you did it (P2.3, DOR-1068)'
  - 'fix(client): the Today showcase draws the digest row it says it draws (DOR-1068)'
---

### Added

- **Today** is the middle of the sidebar now: the conversations, channels, direct messages and
  threads you have actually been in. It is ordered by when **you** last touched each one — so
  your recent conversations stay put while your agents work. An agent starting a turn, finishing
  one, or posting a message moves nothing.
- The conversation you have open is always Today's first row, and it shows what that agent is
  doing right there. When you switch conversations it scrolls into view; it will not scroll for
  anything else, and it never opens a section you folded away.
- Rows also refuse to move while your pointer is inside Today or a row has your keyboard focus.
  If something legitimately changed order while you were reading, it applies the moment you
  move away — so nothing shifts under a cursor that is about to click.
- Scheduled runs, room turns and other work you did not start sit behind one **+ N automated**
  row. Press it to see them, press it again to put them away. If one of them needs you, it
  still appears in **Now** like anything else.
- After you have been away, Today can open with a single **While you were away…** row that
  takes you to what your agents got done. It appears at most once a day, only when something
  actually finished, and only if you have welcome-back notes switched on. Opening any
  conversation dismisses it.
- Anything you have not touched since 4am quietly leaves Today the next morning — except the
  conversation you have open and anything addressed to you by name. Nothing is deleted: it is
  all still one ⌘K away (DOR-1068)

### Fixed

- Reloading the page or following a link straight into a conversation used to leave that
  conversation missing from the sidebar entirely. It is now always there, at the top, even
  before the rest of the list has loaded.
- On day one, an agent could be working and the sidebar would never say so — the Getting
  started suggestions took the space the "N working" line needed. Now working wins that space,
  and Getting started comes back when the work finishes.
- Conversation rows in the sidebar reserved a line for a live status and then left it blank.
  They now say what the agent is doing, matching the status shown in the conversation itself
  (DOR-1068)
