---
covers:
  - "fix(server): read-only tools check the real path, and the shell can't reach protected files unasked (DOR-3300)"
  - 'fix(server): a shell command too big to read is refused, never built in the server (DOR-3300)'
  - 'fix(server): a shell write check that throws refuses the command (DOR-3300)'
---

### Security

- Ask before an agent reads a file outside its folders below Full. The real path decides, so a link to an outside file asks too (DOR-3300).
- Ask before a shell command reaches a secret file below Full, also when it is chained after another command. This reads the command's text, so a path hidden on purpose can still get through (DOR-3300).
- Refuse a shell command that plainly writes an agent's setup files, at every level, and record the attempt in the audit log. This reads the command's text too, so it stops a slip, not an agent set on getting past it (DOR-3300).
