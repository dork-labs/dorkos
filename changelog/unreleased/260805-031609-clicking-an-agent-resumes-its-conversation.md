---
covers:
  - 'fix(client): clicking an agent resumes its conversation, not a blank one (DOR-928)'
---

### Fixed

- Clicking an agent in the sidebar now opens the conversation you left off in. Before, it
  usually opened a blank chat instead, even while the sidebar showed that agent working.
  You only got the real conversation back if you had already opened that agent in the same
  browser tab, so a second window or a fresh reload almost always lost it. An agent with no
  conversations yet still starts a new one (DOR-928)
