---
covers:
  - 'feat(harness): a skill an agent writes is projected within seconds (DOR-1850)'
---

### Added

- A skill your agent writes while it works now shows up in your other coding tools within a few seconds, instead of waiting for you to run a command or restart DorkOS. Most tools read the skills folder directly and see it the moment the file lands; Claude Code reads a different folder, so DorkOS puts a link there for you (DOR-1850)
- DorkOS now tells you when a Claude Code session you already have open needs a restart to see new skills, and only when that is actually true — Claude Code watches the skills folder, but only if the folder was there when the session started (DOR-1850)

### Note for people upgrading

- DorkOS adds these links while you work and never removes them on its own, which is deliberate: it will not delete files in a folder you may be editing right now. So a skill you delete leaves a dead link behind. `dorkos harness sync --check` lists them and `dorkos harness sync --fix` clears them out (DOR-1850)
