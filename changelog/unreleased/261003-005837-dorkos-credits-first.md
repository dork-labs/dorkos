---
covers:
  - 'feat(client): offer DorkOS credits first where nothing works yet (DOR-2630)'
---

### Added

- When Claude Code has no sign-in yet, its setup step now offers DorkOS credits first, with "Sign in with Claude" and "Paste a key" right under it. The same offer shows in first-run setup, in the chat card when a turn could not sign in, and on the banner for a sign-in that is not there. If this computer is not linked to a DorkOS account yet, choosing credits shows the link code right where you are, and Settings › DorkOS account shows the same code. Once you approve it, you pick up where you left off (DOR-2630)
- When an account runs out of usage, the banner now leads with "Keep going on DorkOS credits". Nothing moves to credits unless you choose it, and a sign-in that expired still leads with signing in again (DOR-2630)
