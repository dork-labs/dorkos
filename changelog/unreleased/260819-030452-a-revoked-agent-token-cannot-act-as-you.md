---
covers:
  - 'fix(server,cli): a revoked agent token can no longer act as you in a room (DOR-1361)'
  - 'fix(server): the capability and MCP door refuses a revoked agent token too (DOR-1361)'
  - 'fix(server): a revoked agent cannot get itself recorded as you on a managed MCP server (DOR-1361)'
  - 'docs(server,specs,contributing): the API reference and the record say what a revoked agent token gets (DOR-1361)'
---

### Security

- A program calling DorkOS with an agent token DorkOS cannot verify no longer acts as you in a channel. Until now it could attach files, rename people, stop running work, post messages and read a channel's history, and all of it went into the record as something you did. Every way into a channel now turns that token away and says so: the web addresses, and the tools an agent uses (DOR-1361)
- The same token can no longer get itself written down as you when an MCP server is added to one of your agents. That entry records who added it, and a person reads that line when deciding whether to trust a server that runs a command on their machine, so DorkOS now refuses instead of putting your name on it (DOR-1361)
- When any of this happens to a command you ran, the `dorkos` command line now shows you what the server actually said. It used to tell you your API key was the problem, which sent you to fix the wrong thing (DOR-1361)
