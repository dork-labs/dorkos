---
covers:
  - 'fix(runtimes): enforce shared file protections and managed-server pins (DOR-3595)'
  - 'fix(runtimes): close protected-profile and native env deny gaps (DOR-3595)'
---

### Security

- Keep agents' file tools off private files and DorkOS settings on Codex, OpenCode and DorkOS (DOR-3595).
- Hold changed agent tools for your approval below Full autonomy (DOR-3595).

- Older Codex setups using `exec` now run through app-server and show approval cards (DOR-3595).
