---
covers:
  - 'fix(server,cli): a revoked agent token can no longer act as you in a room (DOR-1361)'
  - 'fix(server): the capability and MCP door refuses a revoked agent token too (DOR-1361)'
  - 'docs(server,specs,contributing): the API reference and the record say what a revoked agent token gets (DOR-1361)'
---

### Security

- A program calling DorkOS with an agent token DorkOS cannot verify no longer acts as you in a channel. Until now it could attach files, rename people, stop running work, post messages and read a channel's history, and all of it went into the record as something you did. Every way into a channel now turns that token away and says so: the web addresses, and the tools an agent uses (DOR-1361)
- When that happens to a command you ran, the `dorkos` command line now shows you what the server actually said. It used to tell you your API key was the problem, which sent you to fix the wrong thing (DOR-1361)
