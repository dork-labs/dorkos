---
covers:
  - "feat(client): the sidebar's Now zone says what needs you, and Getting started fills its slot on day one (P2.2, DOR-1067)"
  - 'fix(client): the all-clear beat lets go when Now comes straight back, and the approvals queue loses its shim (P2.2 review, DOR-1067)'
  - 'fix(client): "N working" counts the conversations you started, not your scheduled runs (P2.2 review, DOR-1067)'
---

### Added

- The top of the sidebar is now a **Now** zone: the things that are actually waiting on you.
  Only four things are allowed in — an agent asking permission, an agent asking a question, a
  session that stopped with an error, and one gentle nudge about a session that went quiet.
  Mentions, unread channels, direct messages and background work never appear there, so a Now
  zone with something in it always means something (DOR-1067)
- Now shows at most three things plus a "+ N more" row that takes you to the home page, where
  the full list already lives. It never scrolls, and agents that are busy working are summed
  into a single "N working" line instead of a row each. That line counts the conversations you
  started — a scheduled run working away in the background is not something that needs you, so
  it stays where it belongs and is never counted here. If one of your scheduled runs does get
  stuck or asks you something, it still comes to Now like anything else
- When the last thing needing you is done, Now says "All clear" for a moment and then folds
  away. If you have asked your system for less motion, it simply disappears
- A new **Getting started** zone takes Now's place on a fresh install. It suggests what you have
  not done yet — add your first agent, ask DorkBot something — and each suggestion retires for
  good once you have done it, even if the thing it was about goes away again later

### Changed

- Zone headings in the sidebar are a little darker, so they meet the readable-contrast bar in
  the light theme as well as the dark one
