---
covers:
  - 'fix(claude-code): an empty turn waits for its answer instead of reporting the agent stopped (DOR-2064)'
  - 'fix(claude-code): an empty turn waits through silence while its reply is still owed (DOR-2064)'
  - 'fix(claude-code): a Stop ends a held empty turn at once, and content is counted the way the guard counts it (DOR-2064)'
---

### Fixed

- Stop telling you the agent did not respond when its reply was only slow to start. With a running agent kept between messages, a restarted agent sometimes finished some of its own background work first, and the app ended your turn right then with an error, while the real reply arrived seconds later with nowhere to show. When that happens, your turn now waits up to 30 seconds for the reply to your message. A turn that stops without saying anything still gets the error, after half a second or, if the agent is still visibly working, up to 30 seconds. Errors, a stopped reply and commands like `/compact` still end the turn right away, and pressing Stop while a turn is waiting ends it at once (DOR-2064)
