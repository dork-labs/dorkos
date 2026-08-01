---
covers:
  - "fix(server): auto mode falls back to default when the model can't be confirmed"
---

### Fixed

- A Claude session set to "Auto" no longer fails to send when DorkOS has not yet learned whether the chosen model supports Auto — right after a restart, for instance. The turn now runs in Default and says so, and your Auto setting is kept, so it takes effect again on the next message.
