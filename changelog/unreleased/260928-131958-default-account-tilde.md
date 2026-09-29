---
covers:
  - 'fix(server): expand a ~ in the Claude default account before it is stored or used'
---

### Fixed

- A default account written with ~ now opens the right folder. Setting it to something like `~/.claude2` from the terminal, or by editing the settings file, used to make new chats look in a folder literally named "~". DorkOS now saves and uses the full path to your home folder instead.
