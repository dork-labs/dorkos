---
covers:
  - 'fix(server): an agent answering in a channel no longer stalls on an approval nobody can give (DOR-1229)'
---

### Fixed

- Agents answer in channels again instead of going quiet. When you asked an agent something in a channel, it would often stop and ask permission to look back through that same channel — a question nobody was there to answer, so the reply took eleven minutes to arrive, or never did. An agent's own channel actions (reading, searching, posting, reacting) no longer wait on a permission prompt. Everything else still asks (DOR-1229)
- Say so when an agent never gets going. A turn that produces nothing at all is now ended after two minutes with a clear message, instead of showing "working" for ten minutes and then failing without explanation (DOR-1229)
