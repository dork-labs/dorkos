---
covers:
  - "fix(marketplace): show and bind the shell commands a skill's text runs (DOR-2327)"
---

### Fixed

- A skill or command can ask Claude Code to run a shell command the moment it is used, written into its text as `` !`command` `` or as a code block marked with an exclamation mark. The install and update previews never showed these, so a package could run commands you were never shown. They now appear with the other commands, naming the skill each comes from, in the app, in `dorkos install` and `dorkos update`, and on agents' approval cards. The same goes for commands in a package's agents and output styles. When a command uses the text you type after it, the card says so, because that text becomes part of the command. A new version that adds or changes one asks you again. Packages you already approved are not asked about again unless they have such a command. Multi-line commands now keep their line breaks on the card, so two commands can't read as one (DOR-2327).
