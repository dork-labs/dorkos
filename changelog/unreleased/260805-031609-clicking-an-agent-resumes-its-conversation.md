---
covers:
  - 'fix(client): clicking an agent resumes its conversation, not a blank one (DOR-928)'
  - 'fix(client): keep agent switching honest about races and failures (DOR-928)'
  - 'fix(client): make the overtaken-navigation guard a mechanism, not a discipline (DOR-928)'
---

### Fixed

- Clicking an agent in the sidebar now opens the conversation you left off in. Before, it
  usually opened a blank chat instead, even while the sidebar showed that agent working.
  You only got the real conversation back if you had already opened that agent in the same
  browser tab, so a second window or a fresh reload almost always lost it. An agent with no
  conversations yet still starts a new one (DOR-928)
- Click two agents quickly and you land on the second one, not whichever one happened to
  load first. The same holds if you click an agent and then open a channel, a thread, or a
  recent conversation: you stay where you last clicked (DOR-928)
- If DorkOS cannot reach the server while opening an agent, it now says so and leaves you
  where you are, instead of dropping you into a blank chat (DOR-928)
