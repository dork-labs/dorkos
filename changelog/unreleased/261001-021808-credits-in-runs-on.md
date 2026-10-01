---
covers:
  - 'feat(credits): make DorkOS credits one more choice in Runs on, never a silent switch (DOR-2623)'
  - 'fix(credits): pin the credits endpoint above folder settings, respect "no", gate agent files (DOR-2623)'
  - 'fix(credits): keep a folder''s own variables on credits, offer "Don''t use credits in this project", notify every refusal (DOR-2623)'
  - "fix(credits): leave the agent's cloud accounts alone, send the refusal reason, offer the project rule only for a folder's own sign-in (DOR-2623)"
---

### Added

- Choose DorkOS credits in the same places you choose a Claude account: Settings › Runtimes › **Runs on**, an agent's Runs on, the account chip before a chat's first message, and **Continue on another account**. Settings › DorkOS account has one switch per runtime credits can pay for (DOR-2623)
- If you link a DorkOS account while Claude Code has no sign-in at all, new Claude Code chats run on credits, and DorkOS tells you once, with **Change** and **Undo all**. If you sign in to Claude Code later, DorkOS offers once to switch back. Turning credits off is remembered, and a sign-in that has expired is never replaced with credits. A computer that was already linked keeps everything as it was and gets one offer you can turn down (DOR-2623)
- An agent runs on DorkOS credits only when you choose that in the app. If an agent's own settings file asks for credits, the agent row says so and offers **Allow** (DOR-2623)
- A project with its own Claude Code sign-in can't run on credits, so the chat now offers **Don't use credits in this project**, which adds a project limit you can remove in Settings › Runtimes (DOR-2623)
- When credits stop a scheduled task, an agent's reply or a room turn, you get a notification instead of nothing (DOR-2623)

### Changed

- Rename the Claude account section in Settings › Runtimes from **Billing account** to **Runs on** (DOR-2623)
- `DORKOS_CLOUD_CREDITS` can now only turn DorkOS credits off: set it to `0`. It no longer turns them on (DOR-2623)

### Fixed

- A chat set to DorkOS credits now stops and says so when credits can't be reached, with **Retry** and **Use your Claude Code sign-in**. It never quietly runs on your own sign-in instead, and a chat on your own sign-in never uses credits. A folder's own Claude Code settings can't send your credits anywhere else, and its other settings, such as `PATH` or a database address, still reach its hooks and commands (DOR-2623)
- DorkOS credits keep working after a restart, and an expiring credits token is replaced before a chat needs it. Unlinking your DorkOS account stops anything running on credits right away (DOR-2623)
