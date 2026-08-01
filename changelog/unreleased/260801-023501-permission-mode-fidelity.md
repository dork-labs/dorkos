---
covers:
  - 'fix(server): a session can only be set to a permission mode its runtime can run'
---

### Fixed

- A session can no longer be set to a safety mode its agent cannot actually run. Setting a Codex session to "Auto", for example, used to be accepted and displayed everywhere while Codex quietly kept running read-only. The setting is now refused with a message naming the modes that agent does support. Sessions already saved in such a mode still open and run as before.
