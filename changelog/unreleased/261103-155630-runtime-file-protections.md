---
covers:
  - 'test(codex): trace host mount targets and unreadable scan failures (DOR-3595)'
  - 'fix(codex): confine parent preparation and trace unowned homes (DOR-3595)'
  - 'fix(codex): prepare protected parents in captured launch homes (DOR-3595)'
  - 'fix(codex): avoid synthetic root metadata masks at Full (DOR-3595)'
  - 'fix(runtimes): enforce shared file protections and managed-server pins (DOR-3595)'
  - 'fix(runtimes): close protected-profile and native env deny gaps (DOR-3595)'
  - 'fix(runtimes): repair CI fixtures and prefix Codex protected globs (DOR-3595)'
  - 'fix(runtimes): explain blocked Linux isolation and add macOS sandbox proof (DOR-3595)'
  - 'fix(runtimes): scope Linux sandbox prerequisites to the probe job (DOR-3595)'
  - 'fix(docs): clarify Codex Docker startup limits (DOR-3595)'
---

### Security

- Keep agents' file tools off private files and DorkOS settings on Codex, OpenCode and DorkOS (DOR-3595).
- Hold changed agent tools for your approval below Full autonomy (DOR-3595).

- Older Codex setups using `exec` now run through app-server and show approval cards (DOR-3595).
- Codex now explains when Linux blocks program isolation and what needs to change. This also applies at Full access (DOR-3595).
- Codex may not start in the standard Docker image.
