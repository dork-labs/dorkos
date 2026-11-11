---
covers:
  - "fix(server): agents can't write a browser sign-in store, so no cookie they plant reaches a later agent browser (DOR-4136)"
  - 'fix(shared): an agent browser that can save its own state or write files is left out (DOR-4136)'
---

### Security

- Agents can't change the browser sign-ins DorkOS keeps: the session every agent browser starts from, the profiles its browsers use, and the Mac app's data folder. Every runtime's file tools refuse, and so does a shell command on Claude Code, at every permission level. Only you save the agent browser's sign-ins, with `dorkos browser login` (DOR-4136).
