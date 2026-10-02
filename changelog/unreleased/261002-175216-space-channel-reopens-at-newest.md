---
covers:
  - "fix(community): forget a space channel's saved row once you catch up (DOR-2170)"
---

### Fixed

- A space channel you read down to its newest message now opens at the newest message next time. Before, once the app had saved a spot higher up, it kept opening the channel there, even after you had read past it (DOR-2170)
