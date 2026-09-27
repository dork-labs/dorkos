---
covers:
  - 'feat(sessions): continue on another account or wait when a session runs out of usage (DOR-2382)'
  - 'fix(sessions): never let a stale plan or state overwrite a newer decision (DOR-2382)'
  - 'fix(sessions): let only Claude Code sessions continue on another account for now (DOR-2382)'
  - 'feat(sessions): move the work to another account on its own when Flow plans it, or to another runtime Flow offers (DOR-2382)'
  - 'fix(sessions): keep unattended to the first turn of an automatic move, and never let a wait or cancel land under it (DOR-2382)'
---

### Added

- When a Claude account runs out of usage, the session it stopped now says what can happen next: move the work to another account, switch to another model when only one model ran out, or wait for the reset. The server keeps this across a restart and updates it as your other accounts' usage changes (DOR-2382).
- New server routes for this: `GET /api/sessions/:id/continue-options` lists your other accounts in order, with the one that has the most room this week first. `POST /api/sessions/:id/continue` starts a new session on the account you pick, in the same folder, with a short summary of where the old one stopped. No model writes that summary, so nothing runs on the account that is out. `POST /api/sessions/:id/wait` and `POST /api/sessions/:id/continue/cancel` hold the session or cancel a pending move (DOR-2382).
- A session that a room, a schedule or a chat connection started can only wait for the reset. Its work never moves to another account. Chats started before this update can only wait for the reset too. For now, only Claude Code sessions can move to another account or model; a Codex or OpenCode session that runs out waits for the reset (DOR-2382).
- When Flow is set to move work on its own, a session that runs out now moves to the account Flow picked, after the wait Flow asked for (at most an hour). Its first turn does not stop for approval cards or questions, like a scheduled run. When you write in the new session yourself, it asks you as usual. If that account has also run out by then, or 8 automatic moves are already running, the session stays where it is and you get a second notice so you can choose. Restarting DorkOS cancels a pending move, and the session asks you instead (DOR-2382).
- The work can also move to Codex or OpenCode when Flow offers one of their accounts. The new session uses that runtime's own model and never gets more permission than the old one had. Full autonomy is never carried over (DOR-2382).
