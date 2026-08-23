---
covers:
  - 'fix(server): stopping an agent no longer leaves an error in the transcript (DOR-1320)'
  - "fix(server): only a stop you asked for clears a turn's error (DOR-1320)"
---

### Fixed

- Stopping an agent no longer leaves a red error behind. The agent shut down cleanly and your next message worked fine, but the chat still recorded the stop as something going wrong (DOR-1320)
