---
covers:
  - "feat(marketplace): let a package mark shipped files as user-editable, and reserve the person's paths (DOR-2245)"
  - 'feat(marketplace): refuse a package that ships a path reserved for the person or the installer (DOR-2245)'
  - 'feat(shared): file notices on install results, agent removal on uninstall results, and the stage/uninstall sibling markers (DOR-2245)'
  - 'feat(shared): write a convention file only when it is absent (DOR-2245)'
  - 'fix(server): strip reserved paths when staging a package (DOR-2245)'
  - 'feat(server): the installed-files record and the carry-over decision table (DOR-2245)'
  - 'feat(harness): resolve ${CLAUDE_PLUGIN_DATA} in projected commands and hooks (DOR-2245)'
  - 'fix(server): a root with no package manifest is not an installed package (DOR-2245)'
  - "feat(server): install transactions keep the person's files (DOR-2245)"
  - "feat(server): every install flow keeps the person's files and reports what it did (DOR-2245)"
  - "feat(server): uninstall in place, keep the person's files, and take an agent off the team (DOR-2245)"
  - 'feat(server): recover crash-left staging and uninstall siblings, and keep a backup when the install is not whole (DOR-2245)'
  - 'refactor(server): update is uninstall-as-replace then install, with no temp scratch dir (DOR-2245)'
  - 'feat(server): a marketplace agent keeps its identity, persona and memory (DOR-2245)'
  - 'feat(server): rebuild the installed-files record of an install made before records existed (DOR-2245)'
  - 'fix(server,cli): uninstall copy says what is kept, and what removing an agent takes away (DOR-2245)'
  - "fix(server): an agent's own SOUL.md and MEMORY.md replace the package's seeds on update (DOR-2245)"
  - 'fix(marketplace): reserved paths match in any case (DOR-2245)'
  - 'fix(server): the legacy record check reads only regular files (DOR-2245)'
  - 'fix(server): prune the uninstall record before deleting the journal (DOR-2245)'
  - 'fix(server): a different package takes the earlier agent off the team before replacing it (DOR-2245)'
  - 'fix(server): an uninstalled agent package leaves no live agent.json behind (DOR-2245)'
  - 'fix(server): register an agent again when recovery rolls back its uninstall (DOR-2245)'
  - 'fix(server): a rolled-back uninstall removes the identity copies it made (DOR-2245)'
  - 'fix(server): match a denied agent folder by its real path (DOR-2245)'
  - "fix(server): an uninstall keeps the person's empty folders (DOR-2245)"
  - 'fix(server): refuse an update the new version can never pass before uninstalling (DOR-2245)'
  - 'feat(marketplace): nothing that decides what a package runs can be user-editable (DOR-2245)'
  - 'fix(server): refuse an uninstall journal whose paths leave the install root (DOR-2245)'
  - "fix(server): an uninstall's own settle registers a restored agent again (DOR-2245)"
  - "feat(marketplace): subagents and output styles can't be user-editable either (DOR-2245)"
---

### Fixed

- Updating or reinstalling a marketplace package keeps the settings and files you and your agents added to it. Before, an update reset everything except two folders, and a reinstall kept nothing (DOR-2245)
- If you changed one of a package's own files, an update saves your copy next to the new one (as `.dork-old`) and tells you, instead of losing it. A package can mark a file as yours to edit, such as a settings file, and then your copy stays and the new default is saved next to it (as `.dork-new`) (DOR-2245)
- A marketplace agent keeps its identity, persona and memory when its package updates. Before, every update gave it a new identity and reset its notes (DOR-2245)
- Uninstalling a package keeps the files you and your agents added or changed, and lists them; reinstalling picks them up. `--purge` still removes everything (DOR-2245)
- An update that the new version could never finish, such as one with a schedule in an unknown time zone, is refused before anything is removed, so the version you had stays installed (DOR-2245)

### Changed

- Uninstalling a marketplace agent now removes it from your team, and the confirmation says what that takes away: its rooms, schedules, sign-ins and access. Reinstalling brings back its identity but not those (DOR-2245)
- Package authors can't mark files that decide what a package runs (hooks, servers, commands, skills, subagents, extensions) as yours to edit, so an update always runs exactly what you approved (DOR-2245)
- Plugins written for Claude Code can keep their own state with `${CLAUDE_PLUGIN_DATA}`, which DorkOS points at a folder inside each install (DOR-2245)
