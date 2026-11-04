---
covers:
  - 'fix(claude-code): MCP server secrets and sign-ins stay off the command line (DOR-3882)'
  - 'fix(claude-code): a server that lands late can still be removed from a running chat (DOR-3882)'
---

### Security

- MCP server settings, headers and sign-in tokens no longer appear on the Claude Code command line, where other programs on your computer could list them. A local server's own settings can still be read by programs running as you, and anything typed into its arguments can be read by every account on your computer, so put secrets in its settings (DOR-3882).
