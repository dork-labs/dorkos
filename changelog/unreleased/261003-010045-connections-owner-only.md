---
covers:
  - 'fix(cloud): make connections, approved account settings and credits schedules owner-only (DOR-2678)'
---

### Fixed

- With login on, only the owner of this DorkOS can now connect, reconnect, pause or disconnect apps, or decide which agents may use them. Someone else signed in can't approve an agent's change to the DorkOS account settings, and their edit to a scheduled task that runs on DorkOS credits puts it back in front of the owner instead of keeping it running. Turning such a task back on is the owner's call too (DOR-2678)
