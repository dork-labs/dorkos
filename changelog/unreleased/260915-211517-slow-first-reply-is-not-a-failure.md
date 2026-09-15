---
covers:
  - 'fix(claude-code): an empty turn waits for its answer instead of reporting the agent stopped (DOR-2064)'
---

### Fixed

- Stop telling you the agent did not respond when its reply was only slow to start. With a running agent kept between messages, a restarted agent sometimes finished some of its own background work first, and the app ended your turn right then with an error, while the real reply arrived a few seconds later with nowhere to show. Your turn now waits up to 30 seconds for that reply as long as the agent is still working, and the error appears only when nothing comes (DOR-2064)
