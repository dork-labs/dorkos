---
covers:
  - 'feat(server,client,shared): scheduled tasks can resume one session across runs (sticky) (DOR-1571)'
  - 'fix(server,relay): sticky resumes the REAL SDK session, captured from the prior run (DOR-1571 review)'
---

### Added

- Scheduled tasks can now pick up where they left off. Flip on the new **Sticky** toggle when you create or edit a task, and every run resumes the same conversation instead of starting cold — so your agent can say things like "since I last ran, here's what changed." It keeps working across restarts, not just back-to-back runs. Leave it off (the default) and each run stays its own fresh, isolated session, exactly as before. Every run still shows up in the task's history, and opening one takes you to that conversation with everything from the runs before it. If a run is still going when the next one is due, that next run is skipped rather than talking over itself. (DOR-1571)
