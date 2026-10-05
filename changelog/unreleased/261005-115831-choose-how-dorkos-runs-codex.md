---
covers:
  - 'feat(config): add runtimes.codex.transport (auto|app-server|exec) (DOR-2719)'
  - "feat(connectors): thread keys resolve only to the open turn's binding (DOR-2719)"
  - 'feat(codex): app-server protocol subset, error table and pinned schema snapshot (DOR-2719)'
  - 'feat(codex): JSON-RPC client for codex app-server; model catalog rides it (DOR-2719)'
  - 'feat(codex): supervised app-server process pool, stopped at shutdown (DOR-2719)'
  - 'feat(codex): turns on app-server — loader, notification mapper, transport (DOR-2719)'
  - 'refactor(codex): transport seam; exec moves behind it unchanged (DOR-2719)'
---

### Added

- A new setting, `runtimes.codex.transport`, chooses how DorkOS runs Codex (DOR-2719). Leave it on `auto` and nothing changes: Codex works exactly as before. Setting it to `app-server` tries an early version of a new way, where one Codex process stays running and keeps a chat ready between replies. The change takes effect after you restart DorkOS.
