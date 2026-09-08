---
covers:
  - "fix(harness): a dead link is drift, and a removed skill's link is swept (DOR-1843)"
  - 'fix(cli): harness sync names orphaned links instead of printing a stack (DOR-1843)'
---

### Fixed

- `dorkos harness sync --check` no longer crashes on a broken link. If a file DorkOS writes for an agent — `.codex/hooks.json`, or the `.claude/CLAUDE.md` pointer — had been replaced by a link to something that is no longer there, the check stopped with a stack trace instead of telling you what was wrong. A broken link is now just one more thing to fix: the check names it, and `--fix` puts the real file back. Anything else that goes wrong is reported as one line, not a stack (DOR-1843)
- A skill you removed or renamed no longer leaves a dead link behind. Deleting `.agents/skills/my-skill` used to leave `.claude/skills/my-skill` pointing at nothing, which Claude Code cannot follow — and the check called it clean. The next sync now names those links and clears them away. Links you made yourself, and real folders you put there, are left alone (DOR-1843)
