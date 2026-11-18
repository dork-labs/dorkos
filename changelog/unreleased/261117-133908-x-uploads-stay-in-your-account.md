---
covers:
  - "fix(connections): an X upload shared with other accounts, or a promoted-only post, needs the agent's own grant (DOR-4332)"
  - 'fix(connections): X owner lists count any non-blank entry, and the docs list the new one-by-one pick (DOR-4332)'
---

### Fixed

- An X upload that lets other accounts use your media, or an ad-only post that won't show on your timeline, now needs to be given to that agent on its own. Read and write, sharing X with every agent, or allowing it in one chat no longer covers them. Ordinary uploads and posts run as before.
