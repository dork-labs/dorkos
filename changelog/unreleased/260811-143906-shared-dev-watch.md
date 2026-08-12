---
covers:
  - "fix(dev): keep @dorkos/shared's build fresh while dev servers run (DOR-1163)"
---

### Fixed

- The dev server no longer dies with connection errors when the code updates underneath it. Previously, `pnpm dev` only built shared code once at startup, so pulling in new changes mid-session could crash the server with a stale build until it was restarted by hand. (DOR-1163)
