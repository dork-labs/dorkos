# Tasks: Agent Trust (program phase 3)

Generated from `03-tasks.json` (canonical). Spec: `02-specification.md`. Umbrella: DOR-428.

| Task | Subject                                                   | Size   | Deps     |
| ---- | --------------------------------------------------------- | ------ | -------- |
| 3.1  | Agent identity: tokens, resolution, Activity attribution  | large  | —        |
| 3.2  | Approval primitive + cockpit card + marketplace migration | large  | 3.1      |
| 3.3  | Tier enforcement at the choke points                      | large  | 3.2      |
| 3.4  | Docker eval isolation tier                                | large  | —        |
| 3.5  | Eval CI cadence workflow                                  | medium | 3.4      |
| 3.6  | Governance eval + trust docs                              | medium | 3.3, 3.4 |

**Critical path:** 3.1 → 3.2 → 3.3 → 3.6, with 3.4 → 3.5 parallel.
Each task is one worktree/PR/review cycle.
