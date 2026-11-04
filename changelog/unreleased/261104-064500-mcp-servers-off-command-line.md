---
covers:
  - 'fix(claude-code): MCP server secrets and sign-ins stay off the command line (DOR-3882)'
---

### Security

- MCP server settings, headers and sign-in tokens no longer appear on the Claude Code command line, where other programs on your computer could list them. A stdio server's own settings can still be read by programs running as you (DOR-3882).
