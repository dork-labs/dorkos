---
covers:
  - 'feat(harness): a project DorkOS manages turns on its own tool (DOR-1901)'
  - 'feat(server): pointing an agent at a project sets it up once (DOR-1901)'
  - 'refactor(harness): the added harness is a value, not a cast (DOR-1901)'
  - 'fix(server): a workspace DorkOS is building projects itself (DOR-1901)'
---

### Added

- Point a DorkOS agent at a project you already work in and DorkOS sets that folder up straight away, instead of waiting for you to run anything. It only adds files — it never deletes anything and never asks you to approve anything on that pass. A brand-new agent still gets its own folder set up by the step that builds it, as before (DOR-1901)

### Fixed

- Turn on the agent DorkOS itself runs your sessions on, even when your project shows no sign of it. A project that has only ever used OpenCode or Codex has nothing of Claude Code's for DorkOS to find, so DorkOS used to leave it off — and the session it then started had never read the `AGENTS.md` you keep in that folder. Now it is turned on, DorkOS says so in one plain line, and the one file it writes is a `.claude/CLAUDE.md` pointing at your own `AGENTS.md` (DOR-1901)
- Say so when a project was set up before that, and does not list the agent DorkOS runs. `dorkos harness sync` and the app both name it and give you the one command that turns it on. Your manifest is still never rewritten behind your back (DOR-1901)
