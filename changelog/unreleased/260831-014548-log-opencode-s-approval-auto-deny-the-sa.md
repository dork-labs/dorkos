---
covers:
  - "fix(server): log opencode's approval auto-deny the same way claude-code does (DOR-803)"
---

### Fixed

- Server logs now record it when an OpenCode agent's unanswered permission request times out, so support and troubleshooting can see it — matching what already happens for Claude Code agents
