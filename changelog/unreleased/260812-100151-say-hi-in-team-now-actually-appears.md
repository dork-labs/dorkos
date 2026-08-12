---
covers:
  - 'feat(server,shared): a room summary says whether you have written in it (DOR-1112)'
  - 'fix(client): "say hi in #team" now reaches the people it was written for (DOR-1112)'
---

### Fixed

- **"Say hi in #team" now actually shows up.** Getting started has always had a suggestion
  nudging you into your team channel, and it could never appear: nothing told the cockpit
  whether you had written there, so it quietly assumed you had. Your room list now says, and
  the suggestion turns up on a fresh install and goes away the moment you post (DOR-1112)
