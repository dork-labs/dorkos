---
slug: harness-sync
number: 267
created: 2026-06-29
status: specified
linearIssue: DOR-137
---

# Harness Sync — cross-agent file projection

**Status:** Draft
**Author:** Dorian
**Date:** 2026-06-29

> SPECIFY output for the **Harness Sync** project (`bc4e663f`, workstream B of
> `plans/agent-harness-portability-roadmap.md`). Inputs: `01-ideation.md` (#267) +
> `spike-findings.md` (DOR-136, which resolved the four open decisions). This is the
> implementation-ready feature spec: it gives DOR-138 (B4 engine) its build contract
> and fully designs the Harnesses UI/UX surface (DOR-137's focus). Governing ADRs:
> **301** (canonical `.agents/` + hybrid projection) and **302** (instructions
> scaffolded, not generated).

> **Note (EXECUTE-time reconciliation, 2026-06-29):** this spec was authored on
> local `main`; while starting Phase 1 it was rebased onto `origin/main`, where the
> in-repo `/flow` source had been **removed** (PR #62 — `/flow` is now an external
> plugin). Consequences: there is **no in-repo flow bundle**, so `skillBundles` is
> empty and the specific **"flow-bundle Codex symlink fix"** is **moot** (the general
> bundle-handling design still holds for any future in-repo bundle); the derivable
> count is **16 `sharedSkills` (0 bundle skills)**, not the "23" cited below. The
> engine, vendored maps, schema, CLI, and UI design are unaffected. Read the
> flow-bundle examples below as illustrative of bundle handling, not current state.

## Overview

Harness Sync projects agent files (skills, instructions, hooks, commands) to every agent
harness a developer runs — Claude Code, Codex, Cursor, Gemini, Copilot. It is the
file-projection complement to the existing `AgentRuntime` runtime abstraction: author,
install, or adopt once, run anywhere, with the projector owning the per-harness transforms
and an **honest drop list** where a harness has no home for an artifact. It projects from
**three source classes** — authored canonical (`.agents/`), marketplace-installed packages
(`.dork/plugins/`), and (by explicit adoption) agent-native assets — through one engine and
one drop list (see "Multi-source projection").

## Background / Problem Statement

Today the projection is partial and hand-maintained: per-skill symlinks into
`.claude/skills/` exist, and `.agents/harness.manifest.json` is a 339-line, **unschema'd**
JSON registry that is **half boilerplate** (23 of its entries restate "symlink
`.agents/skills/X` → `.claude/skills/X`", which a scan derives; the other 23 are genuine
policy/exceptions). Nothing keeps the harnesses in sync, validates the manifest, or
projects hooks/commands/instructions to non-Claude harnesses. The spike also found the
substrate is **stale**: Codex now supports repo-local hooks (`.codex/hooks.json`, 10
events) and does **not** discover skills under `.agents/flow/skills/`, so the manifest's
`codex` hook policy and `sync-harnesses-spec.md` are wrong, and the flow bundle's 8 skills
are invisible to Codex.

## Goals

- A pure, reusable **projection engine** that turns canonical sources + policy into a
  deterministic, idempotent **projection plan** and applies it (symlink / scaffold /
  generate), or checks it write-free.
- **Hybrid discovery:** scan derives the symlink case; a **slimmed, Zod-schema'd**
  manifest carries only non-derivable policy + exceptions.
- **Honesty over false parity:** every run emits an explicit per-harness drop list;
  nothing is silently omitted.
- **Multi-source:** project authored `.agents/`, marketplace-installed plugins
  (automatically), and adopted agent-native assets — one engine, one drop list.
- **Codex as the first concrete cross-harness target** (skills + hooks), proving all three
  mechanisms end-to-end.
- A **Harnesses UI surface**: target selection, per-artifact status, drift indicator,
  re-sync.
- Net-new **instruction scaffolding** wired into agent creation (preserving the
  zero-duplication `CLAUDE.md = @../AGENTS.md` pattern).

## Non-Goals

- Adopting rulesync-the-tool (we **vendor** its maps; see ADR-301).
- **Generating** instruction files — `AGENTS.md` is hand-authored and canonical (ADR-302);
  the engine scaffolds pointers, never rewrites instruction content.
- _Continuous/automatic_ bidirectional sync. Agent-native assets (skills installed by
  Claude/Cursor) enter the canonical source only via an **explicit, reviewable `adopt`**
  (skills + instructions in v1), never auto-promoted — the conflict rule forbids silent
  two-way merges.
- Projecting the DorkOS-only parts of an installed plugin (extensions, adapters) to other
  harnesses — they run only in the DorkOS runtime (honest drop, see Multi-source projection).
- Full per-agent parity for Gemini/Copilot hooks/commands in v1 (contract only; exact
  bytes verified in B9).
- Repo-local MCP-server projection (Codex support unconfirmed — out of scope v1).

## Technical Dependencies

- **Vendored rulesync maps** (npm `rulesync@9.0.2`, MIT, repo `dyoshikawa/rulesync`, pinned
  commit `b4bf09d5`): the hook-event translation tables + per-tool path constants. Vendored,
  not depended-on (the maps are not exported from rulesync's public API). Gemini maps are
  **authored in-repo** (rulesync has none).
- **`@dorkos/skills`** (SKILL.md parser/scanner — reused, not duplicated) and
  **`@dorkos/marketplace`** (`installed-scanner`, for projecting `.dork/plugins/*`). Both are
  pure workspace packages; `@dorkos/harness` composes them.
- **Zod** (already in the repo) for the manifest schema; `z.toJSONSchema` where a JSON
  Schema is needed (the `config-manager.ts` bridge pattern).
- Node `fs` (symlink/scaffold/generate). No SDK, no server dependency in the engine.

## Detailed Design

### Architecture changes

A new **pure package `@dorkos/harness`** (mirrors `@dorkos/skills` / `@dorkos/marketplace`;
depends on both — `@dorkos/skills` for SKILL.md parse/scan, `@dorkos/marketplace` for the
installed-package scan; no server/SDK deps, runnable offline). Three consumers:

- **CLI** (`packages/cli`): `dorkos harness sync` imports `@dorkos/harness` directly and runs
  offline (the `package-init` pattern), so projection works with no server.
- **Server** (`apps/server`): thin `/api/harness/*` endpoints wrap the same engine for the
  client UI (read the plan, apply it).
- **`createAgentWorkspace`** (`services/core/agent-creator.ts`): calls the engine's
  instruction-scaffolding helper on agent creation (B8/B11).

### Code structure & file organization

```
packages/harness/                         # @dorkos/harness (net-new, pure)
├── src/
│   ├── manifest/schema.ts                # Zod: HarnessManifest (slimmed)
│   ├── scan/scanner.ts                   # derive skill entries: .agents/skills/* + bundle sourceRoots + .dork/plugins/*
│   ├── sources/resolve-roots.ts          # the 3 source classes: authored · installed · adopted (+ scope)
│   ├── plan/projector.ts                 # (sources + policy + targets) → ProjectionPlan
│   ├── plan/types.ts                     # ProjectionAction (incl. provenance), ProjectionPlan, DropEntry
│   ├── apply/{symlink,scaffold,generate}.ts  # the three mechanisms
│   ├── adopt/importer.ts                 # Q2: promote agent-native skills/instructions → canonical
│   ├── generate/hooks.ts                 # canonical .claude/settings.json hooks → per-harness hook config
│   ├── vendor/rulesync-maps.ts           # ATTRIBUTED, pinned-SHA event maps + path constants
│   ├── vendor/gemini-maps.ts             # authored in-repo (rulesync has none)
│   └── report/drop-list.ts               # honest per-harness drop list
packages/cli/src/harness-sync-command.ts  # `dorkos harness sync [--check|--fix] [--harness <id>...]`
apps/server/src/services/core/harness/     # thin engine wrapper + routes
apps/client/src/layers/.../harnesses/      # the Harnesses UI surface (FSD feature/widget)
.agents/harness.manifest.json              # SLIMMED (policy only; derivable entries removed)
contributing/harness-sync.md               # dev guide + re-vendor checklist
```

### Data model changes — the slimmed manifest (Zod `HarnessManifest`)

Remove the derivable `sharedSkills` and `skillBundles[].skills` arrays (the scanner
reconstructs them). Keep only non-derivable policy:

```
HarnessManifest {
  version: 1,
  harnesses: HarnessId[],                 // NEW — enabled targets (claude-code default-on)
  claudeOnlySkills: { name, path, reason }[],
  skillWrappers: { target, name, sharedSource, targetPath, reason }[],
  commandMappings: { claudeCommand, target, strategy, status, notes }[],
  instructionScaffolds: { source, status, targets: {tool, mode}[], notes }[],
  hookPolicies: { tool, projection: 'native'|'generate'|'none', configPath?, notes }[],
  skillBundles: { name, manifest, sourceRoot, claudeProjectionRoot, notes }[],  // NO per-skill list
}
```

The runtime (not persisted) plan model:

```
ProjectionAction { kind: 'native'|'symlink'|'scaffold'|'generate'|'drop',
                   artifact: 'skill'|'instruction'|'hook'|'command',
                   provenance: 'authored'|'installed'|'adopted',  // drives gitignore + collision policy
                   harness: HarnessId, source?, target?, reason }
ProjectionPlan   { actions: ProjectionAction[], drops: DropEntry[] }
```

### The projection contract (artifact × mechanism)

- **Skills → symlink/native.** Scan `.agents/skills/*` + each bundle `sourceRoot`. Project per
  enabled harness: Claude → symlink into `.claude/skills/<name>`; Codex → `.agents/skills/<name>`
  (already native for flat skills; **bundle skills must be symlinked into `.agents/skills/`** —
  the spike's Codex-invisibility fix). Honor `claudeOnlySkills` (skip) + `skillWrappers` (rename).
- **Instructions → scaffold (never generate).** `AGENTS.md` is canonical + hand-authored. Scaffold
  only per-harness _pointers_: Claude `CLAUDE.md = @../AGENTS.md`; Codex/Cursor read `AGENTS.md`
  natively (no-op); Gemini `GEMINI.md` pointer; Copilot `.github/copilot-instructions.md` pointer
  (exact filenames `verify in B9`). The generator **excludes** the `agentsmd`/`claudecode`
  instruction targets from content generation by default (ADR-302). Conflict rule: never overwrite
  a hand-authored instruction file's body — on divergence, stop and surface for review.
- **Hooks → generate.** From canonical `.claude/settings.json` `.hooks`, using the vendored
  `CANONICAL_TO_<tool>_EVENT_NAMES`. This repo's 6 events (PreToolUse, PostToolUse, SessionStart,
  Stop, UserPromptSubmit, SubagentStop) map **6/6** to Codex; emit `.codex/hooks.json` (the standalone
  file, **not** inline `config.toml` — bug `codex#17532` breaks interactive SessionStart/Stop) with
  a smoke-test note for those two events, and respect the Codex trust gate. Hooks project to
  **every harness with a hook system** — Claude (native), Codex, Cursor (`CURSOR_HOOK_EVENTS`),
  Copilot (cloud/CLI); **Gemini is the only true drop** (no vendored map yet). Each unmapped
  event → a `drop` with reason. Honesty caveat: the event maps, but a hook whose command runs a
  Claude-specific script may not _behave_ identically elsewhere — the drop list flags "fires;
  verify the script is harness-agnostic," never implying parity.
- **Commands → native; behavior travels as a skill.** Claude `.claude/commands/` stays native. No
  other harness has a repo-local custom-_slash-command_ format (verified for Codex — its
  custom-prompts are user-global + deprecated, replacement = skills), so the `/foo` **trigger** is
  Claude-only. The command's **behavior** is portable by expressing it as a skill (via
  `commandMappings`), which projects everywhere. The drop list records the lost _trigger_, not lost
  _capability_.

### Multi-source projection: installed packages & agent-native assets

The projector reads **three source classes**, in decreasing order of DorkOS control. The
projection mechanisms and the drop list are identical across all three; only the **trigger**,
**provenance**, and **gitignore policy** differ (`ProjectionAction.provenance`):

| Source class          | Location               | Trigger                     | Provenance / gitignore |
| --------------------- | ---------------------- | --------------------------- | ---------------------- |
| Authored canonical    | `.agents/`             | the core flow / `--fix`     | committed              |
| Marketplace-installed | `<scope>/plugins/*`    | **on install (default-on)** | ephemeral → gitignored |
| Agent-native          | `.claude/`, `.cursor/` | **explicit `adopt`**        | promoted → committed   |

**Marketplace-installed plugins (Q1) — on by default.** A DorkOS plugin already ships portable
artifacts (`skills/`, `.dork/tasks/`, `.dork/hooks/`) beside DorkOS-only ones (`.dork/extensions/`,
`.dork/adapters/`, `.dork/mcp-servers/`). The scanner enumerates installed packages (reusing
`@dorkos/marketplace`'s `installed-scanner`) and projects their **portable subset** (skills, hooks)
to every enabled harness, automatically on install/uninstall. We do **not** change where the
marketplace installs. Rules:

- **Scope maps to scope:** project-scoped installs (`<project>/.dork/plugins`) → the project's
  harness dirs; global installs (`~/.dork/plugins`) → the harness _global_ layers (`~/.claude`,
  `~/.agents/skills`, `~/.codex`). Never cross global→project.
- **Installed projections are ephemeral → gitignored** (reproducible from the install); only
  authored-`.agents/` projections are committed. `ProjectionAction.provenance` drives this. (Also
  fix the latent gap: project-local `.dork/plugins/` is currently un-ignored and would be committed.)
- **Claude is a partial special case:** run _through DorkOS_, Claude already receives installed-plugin
  skills via the SDK `plugins` array (`claude-code-runtime.ts:258`), so projecting into `.claude/skills/`
  is redundant there — but it still helps **standalone** Claude Code on the repo, so we project anyway
  (idempotent, same content). The real win is Codex/Cursor/OpenCode, which get nothing today.
- **Drops:** extensions + adapters are DorkOS-runtime-only (hard drop everywhere else); MCP servers
  are portable in principle (future target — see Open Questions). The drop list names each.
- **Uninstall:** a removed plugin's projections are swept by the next `--check`/`--fix` drift pass
  (orphaned-symlink detection), or an explicit engine call from the uninstall flow.
- **Collisions:** authored `foo` vs installed `foo` → installed projections are **namespaced**
  (`<pkg>__foo`) or error; never a silent overwrite (the conflict rule).

**Agent-native assets (Q2) — explicit `adopt`.** `dorkos harness adopt [--from <harness>] [<asset>]`
detects harness-native, non-projected assets (real dirs in `.claude/skills/` that aren't our
symlinks; `.cursor/rules/*`) and **promotes the high-fidelity ones to canonical `.agents/`**, then
projects them everywhere via the same engine. **v1 = skills + instructions:**

- **Skills:** a `SKILL.md` is identical across Claude/Codex → promote into `.agents/skills/` (move +
  symlink back, or copy); zero transformation.
- **Instructions:** Cursor `.cursor/rules/*` / a `CLAUDE.md` fragment → folded into `AGENTS.md`
  **with review** (it is content; the conflict rule applies).
- **Always explicit + reviewable, never automatic** — adoption transfers an asset to DorkOS-managed
  canonical (then re-projects it back as a symlink), an ownership change the command states plainly.
- **Fast-follow (phase 3):** hook-_adopt_ (lift a native Claude hook to canonical and re-generate per
  harness — feasible since hooks are already projectable) and command-adopt (= rewrite as a skill;
  manual, lossy).

### Vendored maps + re-vendor process

`vendor/rulesync-maps.ts` carries an MIT header (repo URL + pinned `b4bf09d5` +
`Copyright (c) 2024 dyoshikawa` + permission text) and exports the 5 event maps
(`CLAUDE`, `CODEXCLI`, `CURSOR`, `COPILOT`, `COPILOTCLI`, each + reverse) and 4 path-constant
sets. `vendor/gemini-maps.ts` is authored in-repo. `contributing/harness-sync.md` documents the
re-vendor checklist (bump SHA, diff the 4 target tables, re-run `--check`).

### API changes

- `GET /api/harness/status` → `{ plan: ProjectionPlan, drift: ProjectionAction[] }` (the `--check`
  result, for the UI).
- `POST /api/harness/sync` → applies the plan; returns the applied actions + drop list.
- CLI: `dorkos harness sync [--check] [--fix] [--harness <id>...]` (default = apply all enabled);
  `dorkos harness adopt [--from <harness>] [<asset>]` (Q2, phase 3 — explicit, reviewable).

## User Experience

### CLI

`dorkos harness sync --check` computes the plan, prints a per-harness table + the drop list, and
exits non-zero on drift (the CI / pre-commit gate). `dorkos harness sync` (or `--fix`) applies it
idempotently and prints what changed + the drop list. `--harness codex` scopes to one target.

### The Harnesses UI surface (DOR-137)

A **Harnesses** page (route `/harnesses`), Calm Tech / status-first (`designing-frontend`):

1. **Target selection** — a card per supported harness (Claude Code, Codex, Cursor, Gemini,
   Copilot) with an enable toggle; toggling writes `manifest.harnesses`. Each card shows its
   read paths.
2. **Per-artifact status table** — rows = artifacts (Skills, Instructions, Hooks, Commands),
   columns = enabled harnesses. Each cell: a quiet status chip — `native` · `projected` ·
   `drift` · `dropped` — with the reason in a tooltip. The drop reasons are inline, never hidden.
3. **Drift banner + re-sync** — when `status.drift` is non-empty, a top banner "N artifacts
   drifted" with a **Re-sync** action → `POST /api/harness/sync`; on success the banner clears.
4. **Drop list panel** — an explicit "Not projected" section per harness with each artifact +
   reason (Priya's honesty gate).
5. **States** — empty (no harness enabled → onboarding nudge), loading (skeleton table), error
   (engine/scan failure surfaced with the failing path).

## Testing Strategy

Harness Sync is **mostly pure filesystem logic, so the bulk is unit + integration, not
browser** — and that is correct, not a gap. The engine/CLI/server are deterministic file
operations best asserted directly; only the Harnesses UI is browser-tested. Four tiers, plus a
live cross-harness smoke. Per-task acceptance criteria live in `03-tasks.json` (`verification`).

- **Unit (Vitest + in-memory/temp fs) — the engine internals.** Maps round-trip (`reverse(forward(e))===e`);
  Zod schema accepts the migrated manifest and **rejects** a stray `sharedSkills`; scanner
  reconstructs the 23 derivable entries; projector plan correctness (incl. the bundle-skill Codex
  symlink + `provenance`); hook generator maps the 6 repo events 6/6 and drops the rest with reasons;
  drop-list completeness (no silent omission); installed-plugin subset projected + extensions/adapters
  dropped; collision namespacing; conflict-stop on a hand-edited instruction body; `adopt` detects only
  non-symlink native assets and requires confirmation.
- **Integration (Vitest temp-dir fixtures + supertest) — the real-scenario tier.** Run the projection
  against a fixture repo and assert the **actual artifacts**: `.claude/skills/<x>` symlinks resolve,
  `.codex/hooks.json` is valid JSON with the right event keys, AGENTS.md/CLAUDE.md scaffolded, flow-bundle
  skills now visible under `.agents/skills/`. `--check` detects an introduced drift (deleted symlink) and
  exits non-zero; `--fix` is idempotent (second run = empty plan); install→project then uninstall→sweep;
  server `/api/harness/*` via supertest.
- **Component + Browser (jsdom + Playwright + Dev Playground) — the Harnesses UI only.** Component (mock
  `Transport`): status chips, drift banner appears/clears, Re-sync POSTs, drop-list panel, empty/loading/error
  states. Browser (`apps/e2e` Playwright): load `/harnesses`, toggle a harness → table updates, Re-sync →
  banner clears. A Dev Playground showcase for the widgets.
- **Live cross-harness smoke (VERIFY stage, scripted/manual).** Actually run **Codex** (then Cursor) against
  the projected files and confirm a skill is discoverable and a generated `.codex/hooks.json` hook fires.
  This is the highest-confidence "does it really work" check, but it is **not in CI** — automating another
  vendor's runtime (install + auth + flakiness) is impractical, so it is a recorded manual smoke; CI covers
  the file-shape, the live smoke covers the runtime load. Start with Codex (the Phase-1 target).

**Mocking:** in-memory/temp-dir fs fixtures for the projector; mock `@dorkos/harness` in server route tests;
mock `Transport` in client tests. Each test carries a purpose comment; cover the drift, collision, conflict,
and drop-list edge cases that can actually fail.

## Performance Considerations

Scan is O(files under `.agents/skills` + bundle roots); symlink/scaffold/generate are cheap and
small. `--check` must be fast enough for a pre-commit / CI gate (no network; pure fs + in-memory
maps). Generation output is a handful of small files per harness.

## Security Considerations

- **Trust gate:** Codex loads repo-local `.codex/` only when the project is trusted; the UI/CLI
  must state this (a generated hook that silently never runs is the false-parity dishonesty we
  forbid).
- **Generated files are tracked** and rewritten across many dirs → the engine is idempotent with a
  write-free `--check`, and **never** overwrites hand-authored instruction bodies (conflict → stop).
- No secrets in generated artifacts; the engine projects only repo-local, non-secret files.

## Documentation

- `contributing/harness-sync.md` (dev guide + re-vendor checklist).
- Update `.agents/skills/syncing-agent-skills/references/sync-harnesses-spec.md` (§5 Codex hooks
  now supported) and the manifest's `codex` hook policy (`none` → `generate`).
- User docs for `dorkos harness sync` + the Harnesses page (Fumadocs, `apps/site`).

## Implementation Phases

- **Phase 1 — core engine (B4–B7 + Codex slice of B9):** `@dorkos/harness` (scanner + Zod schema +
  projector + apply + vendored maps); `dorkos harness sync --check/--fix`; **slim the existing
  manifest**; Codex as first concrete generate target (hooks + bundle-skill symlinks); fix the two
  stale docs.
- **Phase 2 — scaffolding, installed-plugin projection + UI (B8, B10, B11):** instruction
  scaffolding in `createAgentWorkspace` + canonical templates; **marketplace-installed-plugin
  projection (Q1, on-by-default, ephemeral/gitignored, scope-matched)** wired into install/uninstall;
  the Harnesses UI surface; project on agent creation (esp. From Template).
- **Phase 3 — breadth + adopt (B9, B10 cont.):** generators Cursor → Gemini → Copilot (verify exact
  files); **`dorkos harness adopt` (Q2 — skills + instructions)**; hook-adopt + command-adopt
  fast-follow.

## Open Questions

- Exact Gemini/Copilot instruction filenames + hook config formats — **deferred to B9**; the spec
  commits to the _contract_ (scaffold a pointer / generate from the vendored map), not the bytes.
- Harnesses page placement (top-level `/harnesses` vs under Settings) — **recommend top-level**
  (discoverability); finalize in DECOMPOSE.
- **MCP-server projection from installed plugins** (`.dork/mcp-servers/` → each harness's MCP config).
  Portable in principle (Codex/Cursor support MCP) but via per-harness config + a possible trust/secret
  surface — **deferred** past v1; currently an honest drop.
- **Global-install projection into a project** — global `~/.dork/plugins` projects to harness _global_
  layers by default; whether to additionally project a global install into a specific project's harness
  dirs (opt-in) is left for DECOMPOSE.
- Whether to retire `dorkos harness sync` in favor of folding `--check` into a broader `generate` —
  ~~open~~ **(RESOLVED)** Answer: keep `harness sync`. Rationale: it does more than generate
  (symlink + scaffold + generate + drift-check); `sync` matches the rulesync/ruler mental model
  (spike-findings #11).

## Related ADRs

- **ADR-301** — Canonical `.agents/` + hybrid projection; vendor (don't adopt) rulesync maps.
- **ADR-302** — Instruction files are scaffolded, not generated.
- **ADR-303** — Harness Sync is a multi-source projector: marketplace plugins project automatically
  (portable subset, ephemeral), agent-native assets adopt explicitly.
- ADR-0281 (flow-as-plugin) — adjacent; the flow bundle is the first projected package.

## References

- `specs/harness-sync/01-ideation.md` (#267) · `specs/harness-sync/spike-findings.md` (DOR-136).
- `plans/agent-harness-portability-roadmap.md` §B (B4–B11), §8 (ADR drafts A/B).
- `.agents/harness.manifest.json` · `.agents/skills/syncing-agent-skills/references/sync-harnesses-spec.md`.
- rulesync `9.0.2` (`dyoshikawa/rulesync`, MIT, pinned `b4bf09d5`); Codex hooks/skills docs (2026);
  `openai/codex#17532`.
