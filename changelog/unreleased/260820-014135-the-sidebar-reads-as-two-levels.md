---
covers:
  - 'feat(client,shared): the sidebar reads as two levels — one header style, one indent, and every header folds (DOR-1368)'
---

### Changed

- The sidebar is simpler to read. It used to have three levels — a big grey word like "Library", a section heading under it, and then your rows — each starting at a different spot on the left. Now there are two. Every heading looks the same: Heads up, Today, Pins, Channels, Direct messages, Agents, and any section you make yourself. Every row starts on the same line, so a channel, a conversation and an agent all line up (DOR-1368)
- Every heading now folds. Click one to hide what is under it, or hold Option (Alt on Windows) and click to fold the whole panel at once. A folded heading tells you what it is hiding, like "12 · 3 unread". Heads up shows how many things still need you, so folding it can never quietly bury something you have to answer
- The word "Library" is gone from the screen. It named a heading rather than anything you would go looking for. Screen readers still hear it. On your phone, that bottom tab now reads "All"
- A group conversation's stack of faces stops at two and stays inside its own column, instead of sliding under the conversation's name
- Muting a conversation no longer greys out its name. Muted means fewer signals, not harder to read: the name stays crisp, and the bold, the unread count and the working dot go away
- The "+" beside a section is now reachable from the keyboard. Arrow down from a heading to reach New channel, New agent, or New section
