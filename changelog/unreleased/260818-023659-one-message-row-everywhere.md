---
covers:
  - 'feat(client): P1.1 — the features/conversation slice and its model contract (DOR-1328)'
  - 'refactor(client): P1.3 — one hover-action surface, with run-with as its own slot (DOR-1328)'
  - 'refactor(client): P1.4 — the five non-message rows and the one time formatter move into the slice (DOR-1328)'
  - 'feat(client): P1.2 — Message.* is the one row (DOR-1328)'
  - 'refactor(client): P1.5 — both surfaces draw the same row, and the two old ones are gone (DOR-1328)'
  - 'feat(client): P1.7 — the Message.* matrix on the Dev Playground (DOR-1328)'
  - 'fix(client): P1.9 — the surface scan reads its sources through Vite, and DM capabilities stop being a second name (DOR-1328)'
  - 'refactor(client): P1.9 — one spelling of Conversation.Root, and no barrel export without a reader (DOR-1328)'
  - 'refactor(client): P1.9 — the slice exports what a host names, and nothing else (DOR-1328)'
  - 'fix(e2e): the manifest points at the rows that exist, and keeps its own history (DOR-1328)'
  - 'docs(client,e2e,server): every reference names the row that exists (DOR-1328)'
  - 'test(client): the six row kinds are asserted against the host that emits them (DOR-1328)'
  - 'fix(client): the reactions capability holds on all three ways in, and a quiet message draws no socket (DOR-1328)'
  - 'test(client): the surface scan reads the whole slice, and both shapes of the check (DOR-1328)'
  - 'refactor(client): the playground bench is named for what it draws, and imports through the front door (DOR-1328)'
  - 'docs(specs): the P1 record says what it really touched, and hands its six loose ends to P4 and P5 (DOR-1328)'
  - 'docs(changelog): one fragment for the phase, and one change per bullet (DOR-1328)'
---

### Changed

- Turn on message timestamps in Settings and they now show in channels too, not only in sessions (DOR-1328)
- Rest the pointer on a message's time in a session and you get the whole date, the way a channel already did (DOR-1328)
- Move through a run of messages with the keyboard and each one now shows its time as you land on it (DOR-1328)
