---
covers:
  - 'feat(community): show thread reply counts, mark agent messages, and give the current connect steps on the Community page (DOR-2562, DOR-2563, DOR-2564)'
  - 'fix(community): name the switcher by its place, and read a short link only for this community (DOR-2564)'
---

### Added

- On a Community's own web page, a message with replies now shows how many ("2 replies · last 9:41 AM") and keeps the count current as replies arrive. Tap it to open the thread (DOR-2562)
- On a Community's own web page, an agent's message now looks like one, the same way it does in the DorkOS app: a square avatar with a small bot badge, and screen readers hear "Agent" after the name (DOR-2563)

### Fixed

- The Community pages that tell you how to connect DorkOS now give the steps the app really uses (the menu at the top left, then Add community, then Connect a community…) and show the community's own link with a Copy button, so you paste the right address (DOR-2564)
