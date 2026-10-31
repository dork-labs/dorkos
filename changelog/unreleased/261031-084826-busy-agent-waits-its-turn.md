---
covers:
  - 'fix(server): a busy agent waits for its own turn to end instead of retrying ten times a second (DOR-3516)'
---

### Fixed

- When two agents were each asked to post in a room while their chat there was still busy, they could keep waking each other up, about ten times a second. The "working on it" line flickered nonstop and the app used a lot of CPU. Now an agent waits for its own turn to end, then tries once. If it is still busy, it waits longer each time: 1 second, then 2, then 4, up to 30. (DOR-3516)
