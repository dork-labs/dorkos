---
covers:
  - "fix(server): agents can't read the desktop app's sign-in, page storage or built-in browser data (DOR-3613)"
---

### Security

- Agents can't read the Mac app's own data folder, where it keeps your DorkOS sign-in and its built-in browser's sign-ins. This applies on every runtime, the same as the agent browser's own sign-in files (DOR-3613).
