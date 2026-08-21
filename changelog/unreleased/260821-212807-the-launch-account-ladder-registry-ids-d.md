---
covers:
  - 'feat(shared,server): the launch-account ladder — registry ids, defaultAccount, and a per-session hint (DOR-1407)'
---

### Added

- Pin one agent to one Claude account. If you run work and personal Claude
  sign-ins on the same machine, an agent can now be told which one to bill, and
  a single chat can be pointed at another account before you send its first
  message (DOR-1407)

### Changed

- The Claude account you pick in Settings is now called your **default
  account**: new chats bill it unless the agent or the chat itself names
  another. Your current choice carries over — nothing to redo (DOR-1407)
- Naming an account that no longer exists never stops a chat from starting. It
  quietly falls back to your default and notes it in the server log (DOR-1407)
