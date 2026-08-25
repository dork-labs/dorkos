---
covers:
  - 'fix(relay,server,shared): scheduled runs stop echoing dead letters, and carry their unattended context (DOR-1567)'
---

### Fixed

- Scheduled tasks no longer bury you in "could not be delivered" notifications. Every scheduled run was talking to itself: each thing the agent said got sent back to DorkOS as if it were a brand new job, failed to make sense, and turned into a failure notice. One run produced 279 of them. Runs now send that stream nowhere, because nothing was ever reading it. (DOR-1567)
- A scheduled task is now told it is a scheduled task. When the message bus was on — which it is by default — the agent started with none of the usual briefing: what job this is, what schedule woke it, and that nobody is around to answer questions. So it would stop and ask. Both ways of starting a run now hand over the same briefing. (DOR-1567)
- A scheduled run that stops to ask permission now gives up after ten minutes instead of waiting four hours. It already worked that way on one of the two paths a run can take; now it works on both, so a single unanswered prompt can no longer hold a run open for the rest of the day. (DOR-1567)
- A scheduled run that fails is now clickable in the run history, so you can open the transcript and read what went wrong. Finished and cancelled runs already linked to theirs; the failed ones — the runs you actually want to read — did not. (DOR-1567)
