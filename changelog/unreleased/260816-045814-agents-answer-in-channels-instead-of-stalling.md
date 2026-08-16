---
covers:
  - 'fix(server): an agent answering in a channel no longer stalls on an approval nobody can give (DOR-1229)'
  - "fix(server): only an agent's own session skips the card for its channel tools (DOR-1229)"
---

### Fixed

- Agents answer in channels again instead of going quiet. When you asked an agent something in a channel, it would often stop and ask permission to look back through that same channel — a question nobody was there to answer, so the reply took eleven minutes to arrive, or never did. An agent working in its own folder no longer waits on a permission prompt to read, search, post, or react in a channel it belongs to. Every other session still asks, and so does everything else an agent might do (DOR-1229)
- Say so when an agent never gets going. A turn that produces nothing at all is now ended after two minutes with a clear message — "the agent never started working" — instead of showing "working" for ten minutes and then failing without explanation. A turn that starts and then goes quiet is unchanged: it still gets the full ten minutes, and still says it was interrupted (DOR-1229)
