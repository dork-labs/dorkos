---
covers:
  - 'feat(server,skills): skill menus and model listings honor the invocation frontmatter (DOR-1489)'
---

### Fixed

- The two lines you can put at the top of a skill to say who may run it now work everywhere, not just in Claude Code. `user-invocable: false` keeps a skill out of the slash menu, so background-knowledge skills stop crowding the list you pick from in Codex sessions. `disable-model-invocation: true` keeps a skill out of the listing your agents read, so an agent won't reach for a job you meant to start yourself — you can still hand it that skill by name (DOR-1489)
