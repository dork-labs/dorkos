---
covers:
  - 'fix(codex): prepare project folders and refuse missing writable masks (DOR-3595)'
  - 'test(codex): distinguish incomplete Full refusal from complete-home protection (DOR-3595)'
  - 'fix(codex): refuse Linux Full with missing protected targets (DOR-3595)'
  - 'test(codex): prepare root-owned fixtures outside strace (DOR-3595)'
  - 'test(codex): verify blocked descendants of preserved crash files (DOR-3595)'
  - 'test(server): retain fixture shutdown coverage with reason parameter (DOR-3595)'
  - 'fix(codex): project registry lock inspection environment (DOR-3595)'
  - 'refactor(codex): extract app-server process acquisition (DOR-3595)'
  - 'fix(codex): bind pool identity to credits shutdown authority (DOR-3595)'
  - 'fix(codex): isolate agent-home file refusals without dropping protections (DOR-3595)'
  - 'fix(codex): preserve mount targets without inode provenance (DOR-3595)'
  - 'fix(codex): guard cleanup parents and shorten authority shutdown (DOR-3595)'
  - 'fix(codex): repair recovery proof and explain blocking files (DOR-3595)'
  - 'fix(codex): reconcile recorded Linux mount leftovers safely (DOR-3595)'
  - 'fix(codex): retain closing children and allow sandbox cleanup grace (DOR-3595)'
  - 'fix(codex): render existing agent homes as literal protections'
  - 'fix(codex): preserve protected paths through internal symlinks (DOR-3595)'
  - 'docs(codex): explain Linux home scan refusals (DOR-3595)'
  - 'fix(codex): collapse missing protected ancestors without disk writes (DOR-3595)'
  - 'fix(ci): preserve Codex diagnostic artifacts and budgets (DOR-3595)'
  - 'test(codex): trace host mount targets and unreadable scan failures (DOR-3595)'
  - 'fix(codex): confine parent preparation and trace unowned homes (DOR-3595)'
  - 'fix(codex): prepare protected parents in captured launch homes (DOR-3595)'
  - 'fix(codex): avoid synthetic root metadata masks at Full (DOR-3595)'
  - 'fix(runtimes): enforce shared file protections and managed-server pins (DOR-3595)'
  - 'fix(runtimes): close protected-profile and native env deny gaps (DOR-3595)'
  - 'fix(runtimes): repair CI fixtures and prefix Codex protected globs (DOR-3595)'
  - 'fix(runtimes): explain blocked Linux isolation and add macOS sandbox proof (DOR-3595)'
  - 'fix(runtimes): scope Linux sandbox prerequisites to the probe job (DOR-3595)'
  - 'fix(docs): clarify Codex Docker startup limits (DOR-3595)'
---

### Security

- Keep agents' file tools off private files and DorkOS settings on Codex, OpenCode and DorkOS (DOR-3595).
- Hold changed agent tools for your approval below Full autonomy (DOR-3595).

- Older Codex setups using `exec` now run through app-server and show approval cards (DOR-3595).
- Codex now explains when Linux blocks program isolation and what needs to change. This also applies at Full access (DOR-3595).
- Codex may not start in the standard Docker image.
- On Linux, Codex refuses to start if it cannot read a folder in your home folder. Change that folder’s permissions, or move it out of your home folder. A folder that disappears during a scan can also stop a command. Try the command again (DOR-3595).
- On Linux, Codex may refuse to use your home as a project folder. Choose a folder inside it instead. A home reached through a symbolic link may also be refused (DOR-3595).
- Codex names files that block a folder it needs and explains how to retry (DOR-3595).

- On Linux, Codex refuses edits when missing protected paths could create files on your computer. Choose Ask to continue (DOR-3595).
