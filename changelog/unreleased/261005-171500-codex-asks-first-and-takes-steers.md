---
covers:
  - 'fix(codex): start fresh when a thread to reload never ran, and stop a lingering turn before forking (DOR-2719)'
  - 'feat(codex): turn app-server approvals, questions and elicitations into cards (DOR-2719)'
  - 'feat(codex): app-server modes ask first, with honest descriptors and capabilities (DOR-2719)'
  - 'feat(codex): steer a running app-server reply with turn/steer (DOR-2719)'
  - 'fix(codex): MCP approvals only on their own call, labelled elicitations verified, secret questions not drawn (DOR-2719)'
  - 'fix(codex): Ask first says read-only tools run unasked and approved steps reach further, proven on the binary (DOR-2719)'
  # Phase 1 commits (released in v0.98.0) still in this branch's history:
  - 'feat(codex): JSON-RPC client for codex app-server; model catalog rides it (DOR-2719)'
  - 'feat(codex): app-server protocol subset, error table and pinned schema snapshot (DOR-2719)'
  - 'feat(codex): supervised app-server process pool, stopped at shutdown (DOR-2719)'
  - 'feat(codex): turns on app-server — loader, notification mapper, transport (DOR-2719)'
  - 'feat(config): add runtimes.codex.transport (auto|app-server|exec) (DOR-2719)'
  - "feat(connectors): thread keys resolve only to the open turn's binding (DOR-2719)"
  - 'fix(codex): every app-server turn ends with one done, and no stopped turn is ever joined (DOR-2719)'
  - 'fix(codex): fingerprint loads without credential values, and mint identity only on load (DOR-2719)'
  - 'fix(codex): reload one thread on refreshed credentials, bound stuck stops, honest probes (DOR-2719)'
  - 'fix(codex): the pool never orphans or reaps live work, and stays shut after shutdown (DOR-2719)'
  - 'fix(codex): unambiguous thread keys, fuller stderr redaction, and review test gaps (DOR-2719)'
  - "fix(config): classify runtimes.codex.transport's default as no-risk (DOR-2719)"
  - 'refactor(codex): split rate limits and turn parts out of the app-server mapper and transport (DOR-2719)'
  - 'refactor(codex): transport seam; exec moves behind it unchanged (DOR-2719)'
---

### Added

- Codex can ask before it changes things, and you can steer it mid-reply (DOR-2719). In Ask first, Codex asks before every change; it still runs read-only commands, and tools marked read-only, without asking. In Workspace write, it asks before it reaches outside your project or goes online. You approve or deny from a card in the chat. Questions Codex asks you, and forms from its tools, show up as cards too. A question that asks for a password or other secret is skipped for now, and the chat says so. A message you send while Codex is replying joins that reply instead of waiting for the next one.

### Note for people upgrading

- If you set `runtimes.codex.transport` to `app-server`, a Codex chat in Ask first can now make changes. It still asks you first, every time. Before, it could only read. A chat can now start a Codex chat only from Full access, since every Codex level can reach your whole project.
