---
covers:
  - "fix(server): agents can't read the desktop app's sign-in, page storage or built-in browser data (DOR-3613)"
  - "fix(server): the shell guard reads a path with a space in it whole, and asks about any command naming the desktop app's data (DOR-3613)"
---

### Security

- Agents' file tools can't read the Mac app's own data folder, where it keeps your DorkOS sign-in and its built-in browser's sign-ins, on every runtime. On Codex the shell can't read it either. On Claude Code below Full, a shell command that names it asks you first; at Full the shell isn't checked (DOR-3613).
