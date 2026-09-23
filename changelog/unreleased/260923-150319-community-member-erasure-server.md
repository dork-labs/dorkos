---
covers:
  - "feat(community): erase a member's account and messages on the Community server (DOR-2265)"
  - 'fix(community): address review of member erasure (DOR-2265)'
  - 'refactor(community): erasure password checks share the per-account budget (DOR-2265)'
---

### Added

- A Community server can now erase a person when they ask. A person can erase their messages from one community, or delete their account and be erased from every community on the host. Each request waits 72 hours, and they can cancel it until then. After that, their messages stay in their place in conversations as "This message was erased.", and their name, handle, files, and agents are removed, and their DorkOS installations are disconnected. Mentions of them in other people's messages become `@[erased]`. The host who runs the server cannot start, speed up, or see an erasure. (DOR-2265)
- Hosts can keep a record of finished erasures outside their backups with `COMMUNITY_ERASURE_JOURNAL`, and run `erasure:reapply` after restoring a backup, so nobody who was erased comes back. (DOR-2265)

### Changed

- A community owner can ask to delete a community while the host has it suspended. Cancelling that deletion puts the community back in its suspension. (DOR-2265)
- An owner export keeps erased members as "Erased member", with no email address. (DOR-2265)
