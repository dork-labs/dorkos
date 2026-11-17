---
covers:
  - "fix(connections): an X upload shared with other accounts, or a promoted-only post, needs the agent's own grant (DOR-4332)"
---

### Fixed

- An X upload that lets other accounts use your media, or a promoted-only post that stays off your timeline, now needs to be given to that agent on its own. Read and write, or sharing X with every agent, no longer covers them. Ordinary uploads and posts run as before.
