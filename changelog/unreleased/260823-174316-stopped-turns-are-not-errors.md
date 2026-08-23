---
covers:
  - 'fix(server): stopping an agent no longer leaves an error in the transcript (DOR-1320)'
---

### Fixed

- Stop an agent mid-answer and the transcript now shows the turn was stopped, not that something went wrong. Every stop used to leave a red error behind, even though the agent shut down cleanly and your next message worked fine (DOR-1320)
