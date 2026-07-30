---
covers:
  - 'feat(server,shared): choose which Claude Code account new work runs on (DOR-729)'
  - 'feat(server,shared): list and read sessions from every Claude Code account (DOR-729)'
  - 'feat(server,client): pin every turn to its own Claude Code account and apply a switch live (DOR-729)'
  - 'feat(client,shared): choose and switch Claude Code accounts from the cockpit (DOR-729)'
---

### Added

- Do you use more than one Claude Code account on the same computer, maybe one per client? You can now choose which account DorkOS runs your work on, and switch any time. Your session list shows work from all of your accounts together, and each session is labeled with the account it belongs to. Reopening an older session always runs it on the account that created it. This setting only changes DorkOS. Your terminal and the `claude` command keep working exactly as before.

### Note for people upgrading

- Nothing changes until you choose an account. Until then DorkOS works the way it always has. Before this release, DorkOS used whichever account the terminal you launched it from happened to point at. That meant sessions from your other accounts were quietly missing from your list.
