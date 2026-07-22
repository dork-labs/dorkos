# Tasks: Agents as First-Class Operators — Phase 1 (Coherence)

Generated from `03-tasks.json` (canonical). Spec: `02-specification.md`. Umbrella: DOR-428.

| Task | Subject                                                  | Size   | Deps                    | Parallel           |
| ---- | -------------------------------------------------------- | ------ | ----------------------- | ------------------ |
| 1.1  | Marketplace tools on the in-session MCP server           | large  | —                       | 1.3, 1.4, 1.6      |
| 1.2  | Self-service + observability MCP tools                   | large  | —                       | 1.3, 1.4, 1.6      |
| 1.3  | Status-bar prefs → server config (`ui.statusBar`)        | medium | —                       | 1.1, 1.2, 1.4, 1.6 |
| 1.4  | `evaluateSmartGroup` → `@dorkos/shared`                  | small  | —                       | 1.1, 1.2, 1.3, 1.6 |
| 1.5  | Operating DorkOS skill pack v1                           | large  | 1.1, 1.2, 1.6           | —                  |
| 1.6  | CLI operator verbs (`agent`/`task`/`activity`/`version`) | large  | —                       | 1.1, 1.2, 1.3, 1.4 |
| 1.7  | Operate-DorkOS eval cases                                | large  | 1.1, 1.2, 1.3           | 1.5                |
| 1.8  | Docs: agent-operator surface                             | small  | 1.1, 1.2, 1.3, 1.5, 1.6 | —                  |

**Critical path:** (1.1, 1.2, 1.6 in any order) → 1.5 → 1.8, with 1.7 joining after 1.3.
**Wave 1 (no deps):** 1.1, 1.2, 1.3, 1.4, 1.6. **Wave 2:** 1.5, 1.7. **Wave 3:** 1.8.

Full self-contained descriptions and acceptance criteria live in `03-tasks.json`; each task is promoted to its own tracker sub-issue under DOR-428 (multi-agent drain: one task = one worktree = one PR = one reviewed merge).

Phases 2 (registry spine), 3 (trust), 4 (the loop) are scoped in the spec's Implementation Phases and get their own specify/decompose rounds after phase 1 lands.
