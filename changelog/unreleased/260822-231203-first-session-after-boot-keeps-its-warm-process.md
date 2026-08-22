---
covers:
  - "fix(server): a warm process's first launch no longer relaunches on message 2 (DOR-1308)"
  - 'chore(changelog): drop the auto-generated duplicate fragment for DOR-1308'
  - 'fix(server): tighten and correct the DOR-1308 warm-process reasoning-pin fix per review'
---

### Fixed

- With **Keep agents warm between messages** turned on (Settings → Experiments), the very first chat after starting DorkOS now gets its fast second reply too — it no longer quietly restarts its agent once.
