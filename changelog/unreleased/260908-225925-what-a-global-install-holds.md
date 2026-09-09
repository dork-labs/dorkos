---
covers:
  - 'feat(harness): a global install is enumerated, not just named (DOR-1922)'
  - 'feat(harness): say what a global install holds and who sees it (DOR-1922)'
  - 'feat(harness): one line when a package is installed twice (DOR-1922)'
  - 'fix(harness): one skill reads as one skill in the global drop (DOR-1922)'
  - 'fix(harness): a true both-scopes notice, naming this repo (DOR-1922)'
  - 'fix(harness): a rotted global hooks file earns a line (DOR-1922)'
---

### Changed

- Harness Sync now says what a package you installed for all your projects actually holds — its skills by name — and that only the Claude Code sessions DorkOS runs can see it. The old line told you to "run a global sync", a command that has never existed (DOR-1922)
- Say so when one of those packages has a hooks file DorkOS cannot read, instead of reading it and saying nothing (DOR-1922)

### Added

- Tell you when the same package is installed twice, once for all your projects and once in this project. The line says what Claude Code and Codex each do with the pair, and how to remove either copy (DOR-1922)
