---
covers:
  - 'fix(tasks): Ask first and Accept edits schedules can read which chats run and how runs went (DOR-4601)'
---

### Fixed

- Chats and schedules set to Ask first or Accept edits can now check on things without stopping for an approval. They can see which chats are running, read a schedule's past runs, see when each agent last worked, and read an agent's heartbeat, just as Never ask schedules can. At Ask first and Accept edits, these status reads leave out chat titles and run or beat summaries. A turn that read something from outside your team still has to ask first.
