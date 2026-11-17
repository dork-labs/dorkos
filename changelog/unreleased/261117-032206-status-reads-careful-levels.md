---
covers:
  - 'fix(tasks): Ask first and Accept edits schedules can read which chats run and how runs went (DOR-4601)'
---

### Fixed

- Schedules set to Ask first or Accept edits can now check on things without stopping for an approval nobody is there to give. They can see which chats are running, read a schedule's past runs, see when each agent last worked, and read an agent's heartbeat, just as Never ask schedules can. The same limits apply: no chat titles and no run or heartbeat summaries. A turn that read something from outside your team still has to ask first.
