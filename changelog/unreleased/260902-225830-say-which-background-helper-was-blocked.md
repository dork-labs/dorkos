---
covers:
  - 'fix(server,client,shared): say which background helper was blocked, and keep saying it (DOR-795)'
  - 'fix(server): a denial in a turn that never ends is written anyway (DOR-795)'
---

### Fixed

- When an agent sends a helper off to work in the background and that helper needs your permission for something, it has no way to ask you. The request gets turned down for it. That used to happen in silence: the refusal was written into the helper's own notes, which nobody reads, and your conversation just showed an agent that quietly stopped making progress. Now the conversation says so directly, names the helper and the tool it lost, and the note is still there when you come back to the conversation later (DOR-795)
