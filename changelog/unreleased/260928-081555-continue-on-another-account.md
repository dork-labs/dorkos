---
covers:
  - 'feat(client): continue a chat that ran out of usage on another account (DOR-2388)'
---

### Added

- With two or more Claude accounts, you can move a chat's work to another account when its account runs out. Open the account in the status bar and choose "Continue on another account": you see each account's usage left and when it resets, then pick one. It starts a new chat in the same folder with a summary of this one. A chat that can only wait for its reset, such as a Codex chat, offers "Wait for reset" instead (DOR-2388)
