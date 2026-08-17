---
covers:
  - 'fix(server): an agent sends you a note from a channel without a hidden approval (DOR-1265)'
---

### Fixed

- Ask an agent in a channel to send you a note and it now arrives. It used to stop and wait for a permission card that only ever appeared inside the agent's own chat — somewhere nobody was looking — so the note was never sent (DOR-1265)

### Changed

- An agent can send you up to ten notes an hour. Past that it is told to say it in the conversation you are already having, so an agent stuck in a loop cannot fill up your phone. Notes still only go where you already allowed them: your direct message with that agent, or a chat on a connection you set up and gave it permission to start conversations on (DOR-1265)
