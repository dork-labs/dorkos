---
covers:
  - 'feat(client): the sidebar is Now, Today and Library, drawn from one model (P2.1, DOR-1066)'
  - 'fix(client): the zones ship at 16px, the group is addressable, and the guard can fail (P2.1 review, DOR-1066)'
---

### Changed

- **Your sidebar has three parts now: Now, Today and Library.** _Now_ is what needs you.
  _Today_ is what you were working on, in the order you last touched it. _Library_ is the
  structure you built yourself — and **nothing in it moved**. Your pins, your channels,
  your direct messages, your agents and your groups are all exactly where you put them, in
  the order you put them, with the same names. The only new thing above them is a short
  list of what has changed since you looked away.
- Sections open and close by clicking anywhere on their name — you no longer have to hit a
  small arrow. Hold `Alt` (or `Option` on a Mac) while you click and every section opens or
  closes at once.
- A closed section keeps telling you what is inside it. Fold away your conversations and
  the unread count and the "someone is working" dot move up onto the section name, so you
  never lose a signal by tidying up.
- Sections appear when you have something to put in them. There is no "Direct messages"
  heading until you have a conversation, and no "Pins" until you pin something. Grouping
  shows up once you are running eight agents or two different kinds. There is no settings
  toggle for any of it, and there never will be.
- Because the "Direct messages" heading now waits until you have a conversation, starting
  your **first** one moved: it is "New message…" under the `+` beside Agents. Once you have
  one, the `+` beside Direct messages works as it always did.
- Dragging still works everywhere it used to — reordering pins, moving an agent or a
  channel into a group, reordering inside a group. Dragging a row into Now or Today is the
  one thing that does not, because those two lists are worked out for you rather than
  arranged by hand. If you try, DorkOS says so and tells you what to do instead: pin it to
  Library and it stays put.
- Everything in the sidebar is reachable from the keyboard. `Tab` moves between sections,
  the arrow keys move within one, and the `⋮` menu on every row appears on focus as well as
  on hover — so every action is available without a mouse, and on a device with no
  right-click.
