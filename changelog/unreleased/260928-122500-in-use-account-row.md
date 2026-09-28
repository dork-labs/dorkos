---
covers:
  - 'fix(settings): show which Claude account new chats use, even when the folder is written differently'
---

### Fixed

- Settings shows which Claude account new chats use, even when the folder is written differently. Before, if the default account's folder was written with an extra slash at the end, through a shortcut, or with `~`, no account said "in use". It also now follows the account folder DorkOS was started with, when no default is chosen.
