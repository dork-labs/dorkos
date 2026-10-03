---
covers:
  - 'fix(cloud): make connections, approved account settings and credits schedules owner-only (DOR-2678)'
  - 'fix(cloud): keep agents off credits schedules and service keys (DOR-2678)'
---

### Fixed

- With login on, only the owner of this DorkOS can now connect, reconnect, pause or disconnect apps, or decide which agents may use them. Anyone else signed in no longer sees the Connections lists, reviews, requests or events either. Someone else signed in can't approve an agent's change to the DorkOS account settings, and their edit to a scheduled task that runs on DorkOS credits puts it back in front of the owner instead of keeping it running (DOR-2678)
- Agents can no longer put a scheduled task on DorkOS credits or switch one back on, and only you can save or remove the keys DorkOS uses to reach your apps (with login on, only the owner of this DorkOS) (DOR-2678)
