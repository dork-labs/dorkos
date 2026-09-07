---
covers:
  - 'fix(harness): a blocked hooks projection and a file DorkOS stepped over are different answers (DOR-1842, DOR-1844)'
  - 'fix(harness): Codex reads the hooks file we write, and a hooks file you wrote stays yours (DOR-1842)'
---

### Fixed

- Your own hook files stay yours. If you had written a `.codex/hooks.json`, `.cursor/hooks.json` or `.github/hooks/copilot-hooks.json` by hand, installing a marketplace plugin could delete it — even a file for an agent you had not turned on. DorkOS now leaves any hook file it did not write exactly where it is and says so. When it had hooks of its own to put there, it tells you they are blocked and to move them into `.claude/settings.json`, which reaches every agent you run; when it had none, it just notes the file is yours and carries on (DOR-1842)
- Hooks projected to Codex are now written the way Codex reads them. The file DorkOS generated at `.codex/hooks.json` had the right hooks in the wrong shape, so Codex most likely ignored every one of them. Existing files DorkOS wrote are rewritten in place the next time you sync (DOR-1842)
