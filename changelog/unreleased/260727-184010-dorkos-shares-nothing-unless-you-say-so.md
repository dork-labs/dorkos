---
covers:
  - 'feat(telemetry)!: anonymous channels return to opt-in (ADR 260727-182651)'
---

### Changed

- DorkOS now sends us nothing unless you turn it on. The daily heartbeat, marketplace install counts, and feature-usage events used to be on by default. All three are off, and they stay off until you say yes in the Privacy & Data settings tab or with `dorkos telemetry enable`. If you already chose to keep sharing, your choice is kept exactly as it was and nothing changes for you. If you never answered, sharing stops
- The first-run notice now explains what you could share and how to turn it on, instead of telling you sharing is about to begin. On a machine you set up for someone else, `DO_NOT_TRACK=1` still keeps everything off no matter what the settings say
