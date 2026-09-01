---
covers:
  - 'feat(server,shared): sign-in failures reach your phone and clear themselves (DOR-1657)'
---

### Added

- A sign-in that stops working can now reach your phone. If a scheduled task or an agent reply fails because Claude, Codex or OpenCode needs you to sign in again, DorkOS puts a note in your inbox right away, and if nobody has dealt with it after a couple of minutes it pushes to any device you have subscribed and to your connected chat apps. Tapping it opens the page where you sign in. You can change that wait, or turn it off entirely, under Settings, Notifications, in the same place that already decides how long anything else waits before trying another way of reaching you (DOR-1657)

### Changed

- DorkOS now stops telling you about a broken sign-in once it is working again. It watches for the next piece of work that gets through on that sign-in, then files a second note saying it came back. If the same sign-in breaks again later, you hear about it again straight away rather than waiting out a quiet period. Notes about a sign-in are written in the past tense now ("Your Claude sign-in stopped working"), because a note you read the next morning should still say something true (DOR-1657)
