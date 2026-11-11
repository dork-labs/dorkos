---
covers:
  - "fix(server): agents can't write a browser sign-in store, so no cookie they plant reaches a later agent browser (DOR-4136)"
  - 'fix(shared): an agent browser that can save its own state or write files is left out (DOR-4136)'
  - 'fix(shared): an agent browser that brings its own config, in any spelling, is left out (DOR-4136)'
  - 'fix(shared): every refused agent browser flag is refused in its environment form too (DOR-4136)'
  - 'fix(server): an agent set to Full can still save a browser sign-in; below Full it never can (DOR-4136)'
---

### Security

- Agents below Full can't change the browser sign-ins DorkOS keeps: the session every agent browser starts from, the profiles its browsers use, and the Mac app's data folder. Their file tools refuse, and so does a shell command on Claude Code, including `dorkos browser login`. An agent you set to Full can still save a sign-in on Claude Code and Doe, the way you can (DOR-4136).
- No agent can start the agent browser with options that save its state, write files or bring its own config, at any level, Full included (DOR-4136).
