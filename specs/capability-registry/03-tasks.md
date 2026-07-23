# Tasks: Capability Registry (program phase 2)

Generated from `03-tasks.json` (canonical). Spec: `02-specification.md`. Umbrella: DOR-428.

| Task | Subject                                                                 | Size   | Deps    |
| ---- | ----------------------------------------------------------------------- | ------ | ------- |
| 2.1  | Registry core + shared catalog types                                    | large  | —       |
| 2.2  | Migrate operator + marketplace domains; generate both MCP registrations | large  | 2.1     |
| 2.3  | Self-description (API + tool + CLI verb + resource + pointers)          | medium | 2.2     |
| 2.4  | CLI dispatch through capability ids + `dorkos call`                     | medium | 2.3     |
| 2.5  | OpenAPI projection                                                      | medium | 2.1     |
| 2.6  | Conformance suite + discovery eval + docs rewrite                       | large  | 2.2-2.5 |

**Critical path:** 2.1 → 2.2 → 2.3 → 2.4 → 2.6, with 2.5 parallel after 2.1.

Each task is one worktree/PR/review cycle; frozen phase-1 contracts (tool names, CLI flags, HTTP paths) are the regression bar throughout.
