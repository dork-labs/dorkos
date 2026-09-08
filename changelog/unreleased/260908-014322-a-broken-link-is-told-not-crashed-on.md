---
covers:
  - "fix(harness): a dead link is drift, and a removed skill's link is swept (DOR-1843)"
  - 'fix(cli): harness sync names orphaned links instead of printing a stack (DOR-1843)'
  - 'fix(harness): a live link or a directory at a generate target is blocked, never written over (DOR-1843)'
  - 'fix(cli): --check only names orphans the matching --fix would sweep (DOR-1843)'
---

### Fixed

- `dorkos harness sync --check` no longer crashes on a broken link. If a file DorkOS writes for an agent — `.codex/hooks.json`, or the `.claude/CLAUDE.md` pointer — had been replaced by a link to something that is no longer there, the check stopped with a stack trace instead of telling you what was wrong. A broken link is now just one more thing to fix: the check names it, and `--fix` puts the real file back. Anything else that goes wrong is reported as one line, and you can ask for the details with `LOG_LEVEL=debug` (DOR-1843)
- A skill you removed or renamed no longer leaves a dead link behind. Deleting `.agents/skills/my-skill` used to leave `.claude/skills/my-skill` pointing at nothing, which Claude Code cannot follow — and the check called it clean. The next sync now names those links and clears them away. Links you made yourself, real folders you put there, and links that still work are all left alone (DOR-1843)
- DorkOS will not write over a folder, or through a link, where one of its own files belongs. A folder sitting where `.codex/hooks.json` goes used to be reported as something a sync would repair, and the sync then stopped with an error; a link pointing outside your project could have the file at the far end quietly rewritten. Both are now reported as blocked, with a line saying exactly what to move (DOR-1843)
