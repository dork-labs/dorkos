---
covers:
  - 'fix(settings): show which Claude account new chats use, even when the folder is written differently'
  - 'fix(settings): name no row "in use" when $CLAUDE_CONFIG_DIR picks an unregistered folder'
---

### Fixed

- Settings shows which Claude account new chats use, even when the folder is written differently. Before, if the default account's folder was written with an extra slash at the end, through a shortcut, or with `~`, no account said "in use". When DorkOS was started with its own `CLAUDE_CONFIG_DIR` folder and no default is chosen, Settings now says that new chats use that folder.
