---
covers:
  - 'feat(server): recommend tools take a plain task description and say what is already set up (DOR-2854)'
  - 'fix(server): recommend tools read the whole catalog and rank and flag more carefully (DOR-2854)'
  - "fix(server): the recommend helper type-checks outside the server's own program"
---

### Added

- An agent can now describe a job in plain words, such as "summarise my inbox", and get back a short list of apps that could do it, with the ways to connect each one (DOR-2854)
- When an agent looks up an app, it can now see whether you have already given it an account there. When it looks up a marketplace package, it can see whether that package is already installed for it. If DorkOS can't tell, the agent is told that instead of being told no (DOR-2854)
