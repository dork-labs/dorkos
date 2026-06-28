---
feature: Extract /flow into a self-contained external marketplace plugin
slug: flow-plugin-extraction
spec: 266
linearIssue: DOR-133
status: In Progress
lastUpdated: 2026-06-27
---

# Implementation: flow-plugin-extraction (#266)

**Status:** Phases 1 + 2 COMPLETE (plugin built, 414 tests green, `dorkos package validate` + `dorkos marketplace validate` pass, registered). PARKED before Phase 3-4 at the human gates (push + live-verify + destructive removal). Marketplace branch `flow-plugin-extraction` = 4 commits, PUSHED; PR dork-labs/marketplace#1 open. Phase 3-4 (dorkos consume + removal) parked per operator until the live `claude --plugin-dir` verify passes.
**Total tasks:** 14 (Phase 1: 8, Phase 2: 2, Phase 3: 2, Phase 4: 2)

## Cross-repo execution (READ FIRST on resume)

Two repos. The model is amnesiac: recover state from here + the tracker (DOR-133) + git.

- **Marketplace repo (Phases 1-2)** — the plugin's new canonical home.
  - Worktree: `/Users/doriancollier/.dork/workspaces/marketplace/flow-plugin-extraction`, branch `flow-plugin-extraction`.
  - Plugin dir: `<worktree>/plugins/flow/`. Driven via `git -C` + absolute paths (EnterWorktree can't cross repos).
  - Commits so far on the branch: c4d24d7 (scaffold + surfaces + engine .ts), cde1449 (validate-config + rewire).
  - Remote `git@github.com:dork-labs/marketplace.git` — **push is OUTWARD-FACING; PARK + confirm before pushing.**
- **dorkos repo (Phases 3-4)** — becomes a consumer; Phase 4 removes in-repo flow source.
  - A dedicated dorkos worktree will be created at Phase 3 (EnterWorktree works for same-repo dorkos worktrees).
  - **Phase 4 removal is destructive + gated on a live `claude --plugin-dir` verification (3.2) only the operator can fully run. PARK before Phase 4.**
- **Source material:** dorkos branch `spec-flow-marketplace-package`, checked out at
  `/Users/doriancollier/.dork/workspaces/dorkos/spec-flow-marketplace-package`.

## Task status (Phase 1)

- [x] 1.1 scaffold (manifests, dev package.json, hooks/hooks.json) — DONE
- [x] 1.2 commands + flow-loop hook (verbatim copy) — DONE
- [x] 1.3 skills + flow-drain tick (verbatim copy) — DONE
- [x] 1.4 adapters + config + templates + docs + README (verbatim copy) — DONE
- [x] 1.5 engine -> runnable .ts (entrypoints dispatch/gates/involvement/recovery/validate-adapter; libs
      dispatch-policy/gates-policy/config-schema-builder; enum+param-property type-strip fixes) — DONE, 5 oracles smoke-green
- [x] 1.6 validate-config zero-dep (hand-written JSON-Schema check; proven zod-free) — DONE
- [x] 1.8 rewire 60 paths -> ${CLAUDE_PLUGIN_ROOT}; oracle .mjs -> --experimental-strip-types .ts — DONE
- [ ] 1.7 move 413-test suite into engine-tests/, fix imports, re-point tracker-confinement guard, green — RUNNING (agent)
- [ ] (added) bundle + decouple ideating-features + executing-specs; harness-neutral pass; doc residuals — RUNNING (agent)

## KEY DECISION (operator, this session): bundle + DECOUPLE the IDEATE/EXECUTE skills

ideating-features (.agents/skills/) and executing-specs (.claude/skills/) were never migrated into the portable
`.agents/flow/skills/` set, so task 1.3 didn't copy them. executing-specs is heavily dorkos-coupled. Operator chose
**"Bundle + decouple now"**: bundle both into plugins/flow/skills/ AND rewrite host-specific references
(`/worktree:*`, `code-reviewer` agent, `/git:commit`, `/docs:reconcile`, `/spec:feedback`, named host skills) into
GENERIC, harness-neutral capability instructions. Principle: skills give a self-sufficient baseline; the host's richer
skills/tooling get auto-picked-up by the agent when present. KEEP: Task API, subagents, the plugin's own /flow:\*
commands, the linear-adapter tracker seam. Apply the principle across ALL bundled skills/commands, not just the two.

## Integration notes / flags discovered

1. templates/ copied (skills reference them). hooks/hooks.json created (first plugin to ship a hook; Stop hook only
   matters for /flow auto looping — verify at the live gate). zod is DEV-ONLY; the 5 oracles ran with zod uninstalled
   (shipped runtime is genuinely zero-dep). The library modules (config-schema.ts etc.) use zod as VALUES but are only
   loaded at dev/test time, never by the oracle invocations.
2. generate-config-schema.ts has stale repoRoot path math ('..','..','..') from the old packages/flow/scripts location
   — fix during 1.7/2.1 (dev-only `generate:schema` convenience; config.schema.json is already committed).
3. Writable-state-in-bundle (initializing-flow config.local.json creation + cron enabled toggles) targets
   ${CLAUDE_PLUGIN_ROOT}; works for the writable --plugin-dir dogfood clone; a read-only install needs redirection
   (DOR-172 / blessed install loop). Documented limitation.

## Remaining after Phase 1

- 2.1 prove standalone: full vitest green + 5 oracle smokes + adapter conformance (good/bad fixtures) +
  `dorkos package validate ./plugins/flow`. Fix fallout. Also fix generate-config-schema repoRoot.
- 2.2 register in `.claude-plugin/marketplace.json` (relative-path `./plugins/flow`). (marketplace also has a
  `.claude-plugin/dorkos.json` registry — check which is canonical at 2.2.)
- 3.1 dorkos consumer wiring (documented `claude --plugin-dir` invocation) — in a dorkos worktree.
- 3.2 live end-to-end verify — **operator-run; PARK here.**
- 4.1 remove dorkos in-repo flow source + workspace entry + tests (destructive) — **PARK; gated on 3.2.**
- 4.2 repoint dorkos docs + finalize ADRs 0297/0298/0299 (already seeded as drafts in decisions/manifest.json).

## Gates to PARK at (do not cross autonomously)

1. Pushing the marketplace branch to the dork-labs/marketplace remote (outward-facing).
2. Phase 4 dorkos removal (destructive + premised on the operator's live --plugin-dir verification).
