---
covers:
  - 'fix(claude-code): hold a message that would restart the agent while its background work runs'
  - 'fix(claude-code): close the gaps review found in holding a restart for background work'
  - 'fix(claude-code): keep a held message held through a server shutdown'
  - "fix(claude-code): keep a warm process while its background shell runs, and pin a new chat's account once it has a transcript"
  - 'fix(claude-code): retry a missed account probe, drop day-old wake records'
  - 'fix(claude-code): wake a chat whose agent process ended while its background work still ran'
  - 'fix(claude-code): wake only after a restart, and let a lone shell give way'
---

### Fixed

- A message that needs the agent to switch folders, instructions or settings no longer stops the helpers, Monitors or background commands it is still running. The message waits in the queue and says what it is waiting on. Press **Switch now** to run it anyway and stop that work. After four hours it runs on its own.
