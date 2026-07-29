---
covers:
  - 'feat(server,shared): choose which Claude Code account new work runs on (DOR-729)'
  - 'feat(server,shared): list and read sessions from every Claude Code account (DOR-729)'
---

### Added

- If you use more than one Claude Code account on the same computer — say one per client — you can now pick which one DorkOS runs on, and switch whenever you like. Your session list shows work from all of your accounts at once, each labelled with the account it belongs to, and reopening an older session always runs it on the account that created it. Setting this only affects DorkOS: your terminal and the `claude` command keep working exactly as before.

### Note for people upgrading

- Nothing changes until you pick an account. Until then DorkOS behaves exactly as it did. Before this release, the account was decided by the terminal you happened to launch DorkOS from, which meant sessions belonging to your other accounts were quietly missing from the list.
