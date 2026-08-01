---
covers:
  - "fix(server): auto mode falls back to default when the model can't be confirmed"
  - 'fix(server): an unconfirmed model gets its own honest auto-mode explanation'
  - "fix(server): a Claude session in auto or don't-ask no longer lists as default"
  - "fix(relay): a scheduled run's permission mode is checked, not just carried"
  - 'refactor(shared): drop the create-session request schema nothing sends'
---

### Fixed

- The session list now shows the real permission mode for Claude sessions running in "Auto" or "Don't ask". Both used to be reported as "Default", which made an unattended session look like it was still asking before every tool.
- A Claude session set to "Auto" no longer fails to send when DorkOS has not confirmed that the chosen model supports Auto — right after a restart, for instance. The turn runs in Default and says it could not confirm, and your Auto setting is kept, so it applies again as soon as the model is confirmed.
