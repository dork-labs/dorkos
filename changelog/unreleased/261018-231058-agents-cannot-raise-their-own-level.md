---
covers:
  - 'fix(server): an agent can no longer raise its own permission level by editing its settings file (DOR-3107)'
---

### Fixed

- An agent can no longer give itself more power by editing its own settings file. DorkOS now keeps a copy of what you set for each agent in its own data folder, which agents can't reach. The agent's file can make it more careful, never less.
- On upgrade, each agent starts at the stricter of its settings file and the last level a person set for it. An agent that raised its own level before the upgrade goes back to yours.
- A chat an agent opens while answering a message from someone outside your team, such as a Telegram message, no longer starts at that agent's own level.
