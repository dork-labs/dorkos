---
covers:
  - 'fix(shared,skills,server,memory,marketplace): awkward text cannot stall the server'
---

### Fixed

- Fixed a set of text patterns that got dramatically slower as the text got longer. A few of them were reachable from outside: a scheduled task's time limit, a crash report's stack trace, and a chat message or transcript carrying a wall of half-finished tags could each tie the server up long enough to stop answering anyone. Reading those now takes the same steady time no matter what arrives, and a task's time limit has to look like a time limit.
