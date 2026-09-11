---
covers:
  - 'fix(opencode): keep a stopped subagent from reading as a failure'
---

### Changed

- An OpenCode subagent whose last tool call failed now shows as failed. It used to hand back whatever the subagent had written up to that point and read as finished.

### Fixed

- Stopping an OpenCode subagent now shows as stopped instead of failed. OpenCode changed the wording it sends when a subagent ends early, and DorkOS was reading the new wording as a crash.
