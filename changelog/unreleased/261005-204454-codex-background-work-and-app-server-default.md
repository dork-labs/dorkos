---
covers:
  - 'feat(codex): background work on app-server wakes the chat, and a lost thread starts fresh with a notice (DOR-2719)'
  - "fix(codex): Ask first on app-server declares what Claude Code's Default declares, so a Default chat can start it (DOR-2719)"
  - 'feat(codex): Codex runs on app-server by default (DOR-2719)'
---

### Added

- Background commands Codex starts keep running after its reply, and the chat picks up when they finish: Codex reads the result and carries on (DOR-2719). It does this only after a reply that ended normally, and never for a command that runs until you stop it, like a dev server. You can stop one from the task bar above the chat box, and DorkOS stops one that is still running four hours after its reply.

### Changed

- Codex now asks before it changes things, and takes a message you send mid-reply, in every Codex chat (DOR-2719). This was opt-in before. To go back to the old way, set `runtimes.codex.transport` to `exec` and restart DorkOS.
- A Claude Code chat in Default, Accept edits or Auto can now start a Codex chat in Ask first (DOR-2719). Starting one in Workspace write or Full access still needs a chat in Full access.

### Fixed

- If you deleted or archived a Codex conversation in Codex itself, your next message in DorkOS starts a fresh one and tells you so. Before, a deleted one started fresh without a word, and an archived one failed the message (DOR-2719).

### Note for people upgrading

- A Codex chat in Ask first can now make changes. It still asks you first, every time. Before, it could only read.
