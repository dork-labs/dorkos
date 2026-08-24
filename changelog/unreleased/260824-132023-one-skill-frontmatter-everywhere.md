---
covers:
  - 'feat(skills): one skill frontmatter schema, with a schedule block (DOR-1484)'
---

### Changed

- Skill files now take one set of options, everywhere. The settings that used to work only at the top of a command file work at the top of any skill: a hint for its arguments, a model, an effort level, and running it in a forked helper. DorkOS also reads the rest of Claude Code's options now, including which tools to keep away from a skill, which files it applies to, and which shell runs its inline commands. A skill you wrote for Claude Code needs no changes to be read correctly here (DOR-1484)

### Added

- A skill file can now carry a `schedule:` block that says when it should run: a time, a timezone, a time limit, how much the run may do on its own, and what to send when it fires. DorkOS reads and checks that block today, and a value it cannot make sense of is reported instead of quietly ignored. Actually running a skill from its own `schedule:` block arrives in a later change (DOR-1484)
