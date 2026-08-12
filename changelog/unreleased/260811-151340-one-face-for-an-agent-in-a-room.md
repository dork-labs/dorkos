---
covers:
  - 'fix(client): a room draws an agent with the same face as everywhere else (DOR-1002)'
  - "fix(client): a room's mark and its mention cards wear the agent's face too (DOR-1002)"
---

### Fixed

- Your agents now look the same inside a room as they do everywhere else. The
  row of faces at the top of a room, the picture beside each message, the mark
  on a direct message, and the little card you get when you point at someone's
  name all used to fall back to a plain letter for most agents. The sidebar
  showed the agent's real emoji and color the whole time, so one agent could
  look like two or three at once. They all show the same face now.
- An agent we cannot find still shows a letter rather than a made-up face. A
  guessed face would look certain and match nothing else on your screen.
