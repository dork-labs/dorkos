---
covers:
  - 'feat(harness): adopt moves one skill and leaves the link (DOR-1944)'
  - 'feat(cli,harness): dorkos harness adopt, and sync says who cannot see (DOR-1944)'
  - 'feat(client,server): the Skills row prints the command that moves a skill (DOR-1944)'
---

### Added

- A skill your agent wrote inside one tool's folder can now be moved to where every agent reads it, with one command: `dorkos harness adopt <name>`. It moves the folder to `.agents/skills` in one step — either the whole skill arrives or nothing happens — and leaves a link behind so Claude Code still finds it. Add `--check` to see what it would do without writing anything, or `--claude-only` to say the skill belongs to Claude Code and should stay put (DOR-1944)
- DorkOS tells you when it will not move a skill, and why. A skill whose settings only Claude Code understands, one whose text points at a Claude Code path, a name already taken in `.agents/skills`, a folder that is really a link somewhere else — each gets one plain sentence naming the thing in the way and what to do about it, and nothing on disk is touched (DOR-1944)
- Every `dorkos harness sync` now names the skills that live where only some of your agents look, one line per folder, with the command that moves each. It says which of your tools cannot see them — worked out from what each tool documents about itself, not from a list DorkOS wrote down — and stays quiet when every tool you use can already read them (DOR-1944)

### Changed

- The Skills page prints the command that moves a skill, right under the line saying where it lives. It carries your project's full path, so it means the same thing wherever you paste it (DOR-1944)
