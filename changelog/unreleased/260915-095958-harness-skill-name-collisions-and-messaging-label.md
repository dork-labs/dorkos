---
covers:
  - 'fix(harness): one skill name in two tool folders is a collision each tool is told about (DOR-1940)'
  - 'fix(marketplace): the install preview says messaging connections, not the retired noun (DOR-1936)'
---

### Fixed

- Tell you when one skill name is in two folders the same agent tool reads. If `review-pr` lives in both `.claude/skills` and `.opencode/skills`, OpenCode sees two skills under one name — DorkOS now says so beside both of them, along with what that tool's own documentation says happens: one of them loses, both load, or nobody wrote it down. Both copies still show as read by the tool, because both really do load (DOR-1940)
- Say "Adds messaging connections" where the marketplace install preview used to say "Installs messaging adapters" (DOR-1936)
