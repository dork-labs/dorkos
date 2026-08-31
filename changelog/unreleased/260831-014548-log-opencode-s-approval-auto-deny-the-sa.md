---
covers:
  - "fix(server): log opencode's approval auto-deny the same way claude-code does (DOR-803)"
---

### Fixed

- When an OpenCode agent gives up waiting for a permission nobody answered, the server now logs it — matching what already happens for Claude Code agents
