---
covers:
  - 'fix(claude-code): hold a message that would restart the agent while its background work runs'
---

### Fixed

- A message that needs the agent to switch folders, instructions or settings no longer stops the helpers, Monitors or background commands it is still running. The message waits in the queue and says what it is waiting on. Press **Switch now** to run it anyway and stop that work. After four hours it runs on its own.
