---
feature: Extract /flow into a self-contained external marketplace plugin
slug: flow-plugin-extraction
spec: 266
linearIssue: DOR-133
status: In Progress
lastUpdated: 2026-06-27
---

# Implementation: flow-plugin-extraction (#266)

**Status:** In Progress
**Total tasks:** 14 (Phase 1: 8, Phase 2: 2, Phase 3: 2, Phase 4: 2)

## Cross-repo execution (READ FIRST on resume)

This spec spans TWO repos. The model is amnesiac: recover state from here + the tracker (DOR-133) + git.

- **Marketplace repo (Phases 1-2)** — the plugin's new canonical home.
  - Worktree: `/Users/doriancollier/.dork/workspaces/marketplace/flow-plugin-extraction`
  - Branch: `flow-plugin-extraction` (off marketplace `main` @ 6878eef)
  - Plugin dir: `<worktree>/plugins/flow/`
  - Remote: `git@github.com:dork-labs/marketplace.git` — **push is OUTWARD-FACING; park and confirm before pushing.**
- **dorkos repo (Phases 3-4)** — becomes a consumer; Phase 4 removes in-repo flow source.
  - A dedicated dorkos worktree will be created at Phase 3 (not yet).
  - **Phase 4 removal is destructive + gated on Phase 3.2 (live `claude --plugin-dir` verification, which only the operator can fully run). PARK before Phase 4.**

- **Source material:** dorkos branch `spec-flow-marketplace-package`, checked out at
  `/Users/doriancollier/.dork/workspaces/dorkos/spec-flow-marketplace-package` (the #264 deliverables). Copy from there.

## Batch plan (dependency-aware)

- B1: 1.1 scaffold (DONE — manifests, dev package.json, hooks/hooks.json).
- B2 (parallel): 1.2 commands+hook copy · 1.3 skills+tick copy · 1.4 adapters/config/docs/**templates** copy · 1.5 engine port to .ts.
- B3: 1.6 validate-config zero-dep · 1.8 rewire oracle invocations.
- B4: 1.7 move tests + re-point tracker-confinement guard.
- B5: 2.1 prove standalone (tests green, oracles run, dorkos package validate) · 2.2 register in registry.
- B6 (dorkos worktree): 3.1 consumer wiring · 3.2 verify end-to-end (PARK for operator live check).
- B7 (PARKED): 4.1 remove dorkos flow source · 4.2 repoint docs + finalize ADRs.

## Integration notes discovered during execution (not in the original task breakdown)

1. **templates/ must be copied** — `.agents/flow/templates/` (docs/ + records/ + pr.md) is referenced by the
   stage skills (e.g. specifying-work uses `templates/docs/specification.md`). Added to task 1.4's copy set.
2. **hooks/hooks.json** — flow is the first marketplace plugin to ship a hook. Created
   `plugins/flow/hooks/hooks.json` registering the Stop hook as
   `cd "$(git rev-parse --show-toplevel)" && node "${CLAUDE_PLUGIN_ROOT}/hooks/flow-loop.mjs"` (keeps the `cd` to the
   CONSUMER repo root so `.dork/flow/auto-run.json` resolves; loads the script from the plugin). The Stop hook only
   matters for `/flow auto` looping — manual `/flow:<stage>` works without it. Verify/refine at the 3.2 gate.
3. **Path-rewiring is broader than oracle .mjs invocations** — the copied skills/commands carry many
   `.agents/flow/...`, `.claude/commands/flow...`, and `.dork/tasks/flow-drain` repo-relative references (templates,
   adapters/SPEC.md, config paths). Task 1.8 is expanded to map ALL of these to `${CLAUDE_PLUGIN_ROOT}/...`. The 2.1
   gate is where residual path breakage surfaces.

## Session 1 - 2026-06-27

### Tasks Completed

- Task 1.1: Scaffold plugins/flow/ skeleton, manifests, dev package.json, hooks/hooks.json

### Files Created

- plugins/flow/.dork/manifest.json (type plugin, layers [commands,skills,hooks])
- plugins/flow/.claude-plugin/plugin.json
- plugins/flow/package.json (dev-only: vitest, tsx, zod, ajv; NO esbuild, NO build script, NO workspace deps)
- plugins/flow/hooks/hooks.json (Stop hook registration)

### Known Issues / Open

- README.md owned by task 1.4 (filled from source .agents/flow/README.md).
- vitest.config.ts + tsconfig.json created by task 1.7 (the package.json "test"/"typecheck" scripts need them).
