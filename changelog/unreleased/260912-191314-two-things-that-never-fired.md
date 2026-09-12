---
covers:
  - 'fix(claude-code): make the auto-mode classifier note actually fire for DorkOS tools'
  - 'fix(tasks): record refused asks on scheduled runs that go through the relay'
---

### Fixed

- Auto mode is told again what DorkOS already decided about its own tools. The note that says "DorkOS checked this one" was being registered in a way the runtime read as a tool name rather than a pattern, so it matched nothing and was never sent — auto mode went on guessing about every DorkOS tool and stopping to ask about calls DorkOS had already cleared.
- A scheduled run that could not use a tool now says so in your activity feed. The run's own summary already told you which tools it skipped, but the feed entry only appeared on one of the two ways a run can be started — and not the one nearly every install actually uses. Overnight runs that reached for something needing your approval left no trace in the feed at all.
