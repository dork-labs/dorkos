---
covers:
  - "fix(server): read-only tools check the real path, and the shell can't reach protected files unasked (DOR-3300)"
  - 'fix(server): a shell command too big to read is refused, never built in the server (DOR-3300)'
  - 'fix(server): a shell write check that throws refuses the command (DOR-3300)'
  - "fix(server): the shell guard's whole check runs on one work budget, and its wildcards can't backtrack (DOR-3300)"
  - "fix(server): the shell guard's wildcards read as a real shell does, and a part it can't read refuses the command (DOR-3300)"
  - "fix(server): the shell guard reads a command in its own process, so it can't stall or crash the server (DOR-3300)"
---

### Security

- Ask before an agent reads a file outside its folders below Full. The real path decides, so a link to an outside file asks too (DOR-3300).
- Ask before a shell command reaches a secret file below Full, also when it is chained after another command. This reads the command's text, so a path hidden on purpose can still get through (DOR-3300).
- Refuse a shell command that plainly writes an agent's setup files, at every level, and record the attempt in the audit log. This reads the command's text too, so it stops a slip, not an agent set on getting past it (DOR-3300).
- Stop shell commands at Full, and ask below it, when DorkOS can't start its check on them. You get a notice on your phone too (DOR-3300).
- If a restart doesn't bring that check back, you can choose in the app to go on without it. The choice ends when you restart, and it is recorded in the audit log (DOR-3300).
