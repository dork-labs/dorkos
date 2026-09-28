---
covers:
  - 'feat(sessions): continue on another account or wait when a session runs out of usage (DOR-2382)'
  - 'fix(sessions): never let a stale plan or state overwrite a newer decision (DOR-2382)'
  - 'fix(sessions): let only Claude Code sessions continue on another account for now (DOR-2382)'
---

### Added

- When a Claude account runs out of usage, the session it stopped now says what can happen next: move the work to another account, switch to another model when only one model ran out, or wait for the reset. The server keeps this across a restart and updates it as your other accounts' usage changes (DOR-2382).
- New server routes for this: `GET /api/sessions/:id/continue-options` lists your other accounts in order, with the one that has the most room this week first. `POST /api/sessions/:id/continue` starts a new session on the account you pick, in the same folder, with a short summary of where the old one stopped. No model writes that summary, so nothing runs on the account that is out. `POST /api/sessions/:id/wait` and `POST /api/sessions/:id/continue/cancel` hold the session or cancel a pending move (DOR-2382).
- A session that a room, a schedule or a chat connection started can only wait for the reset. Its work never moves to another account. Chats started before this update can only wait for the reset too. For now, only Claude Code sessions can move to another account or model; a Codex or OpenCode session that runs out waits for the reset (DOR-2382).
