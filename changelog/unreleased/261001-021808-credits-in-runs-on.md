---
covers:
  - 'feat(credits): make DorkOS credits one more choice in Runs on, never a silent switch (DOR-2623)'
---

### Added

- Choose DorkOS credits in the same places you choose a Claude account: Settings › Runtimes › **Runs on**, an agent's Runs on, the account chip before a chat's first message, and **Continue on another account**. Settings › Access › DorkOS account has one switch per runtime credits can pay for (DOR-2623)
- If you link a DorkOS account while Claude Code has no working sign-in, new Claude Code chats run on credits, and DorkOS tells you once, with **Change** and **Undo all**. If you sign in to Claude Code later, DorkOS offers once to switch back. A computer that was already linked keeps everything as it was and gets one offer you can turn down (DOR-2623)

### Changed

- Rename the Claude account section in Settings › Runtimes from **Billing account** to **Runs on** (DOR-2623)
- `DORKOS_CLOUD_CREDITS` can now only turn DorkOS credits off: set it to `0`. It no longer turns them on (DOR-2623)

### Fixed

- A chat set to DorkOS credits now stops and says so when credits can't be reached, with **Retry** and **Use your Claude Code sign-in**. It never quietly runs on your own sign-in instead, and a chat on your own sign-in never uses credits (DOR-2623)
- DorkOS credits keep working after a restart, and an expiring credits token is replaced before a chat needs it (DOR-2623)
