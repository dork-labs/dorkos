---
covers:
  - 'feat(client): offer DorkOS credits first where nothing works yet (DOR-2630)'
  - 'fix(client): carry a DorkOS link on only where it was started, and ask before spending (DOR-2630)'
---

### Added

- When Claude Code has no sign-in yet, its setup step now offers DorkOS credits first, with "Sign in with Claude" and "Paste a key" right under it. The same offer shows in first-run setup, in the chat card when a turn could not sign in, on the banner for a sign-in that is not there, and on your phone. If this computer is not linked to a DorkOS account yet, choosing credits shows the link code right where you are, and Settings › DorkOS account shows the same code. Once you approve it, you pick up where you left off. Before anything is sent again, DorkOS asks you first (DOR-2630)
- When an account runs out of usage, the banner now leads with "Keep going on DorkOS credits". Nothing moves to credits unless you choose it, an account with no credits left is offered a way to add some instead, and a sign-in that expired still leads with signing in again. If you turned credits off for a runtime, your own sign-in stays first (DOR-2630)
