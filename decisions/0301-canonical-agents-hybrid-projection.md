---
number: 301
title: Project a canonical .agents source to every harness via hybrid discovery and vendored maps
status: accepted
created: 2026-06-29
spec: harness-sync
superseded-by: null
---

# 301. Project a canonical .agents source to every harness via hybrid discovery and vendored maps

## Status

Accepted (implemented in spec: harness-sync, `@dorkos/harness`)

## Context

DorkOS abstracts the agent _runtime_ (`AgentRuntime`) but not the _files each agent reads_ — skills, instructions, hooks, and commands differ per harness (Claude Code, Codex, Cursor, Gemini, Copilot). Today the projection is partial and hand-maintained: per-skill symlinks plus an unschema'd `.agents/harness.manifest.json` that is half derivable boilerplate. The external tools rulesync/ruler cannot read `.agents/`, expose no plugin API, and only copy (never symlink), and their valuable cross-agent maps are module-internal (not importable); the spike (DOR-136) confirmed this against rulesync `9.0.2`.

## Decision

We will keep `.agents/<name>` as the canonical source and project **per artifact type**: symlink identical-format artifacts (skills), scaffold instructions (ADR-302), and generate transformed ones (hooks, commands). Discovery is **hybrid** — a filesystem scan derives the common symlink case, while a **slimmed, Zod-schema'd** manifest carries only non-derivable policy and exceptions. We will **vendor** rulesync's hook-event maps and path constants (MIT, pinned to commit `b4bf09d5`, attributed) rather than adopt rulesync-the-tool, authoring Gemini's maps in-repo (rulesync has none). We own the projector, which emits an explicit per-harness drop list (honesty over false parity).

## Amendment — 2026-09-08 (DOR-1858)

The "slimmed, Zod-schema'd manifest carrying only non-derivable policy and exceptions" was slimmed by half and then not read. The engine read `harnesses` and `claudeOnlySkills`; `skillWrappers`, `commandMappings`, `instructionProjections`, `hookPolicies` and `skillBundles` were validated on every load and consulted by nobody. A field that is validated but never read is a claim nobody checks, which is the same fault this ADR set out to remove — this repo's own `skillWrappers` entry named a wrapper that was never built.

The manifest's key set is now **`harnesses`, `claudeOnlySkills`, `hookPolicies`**, and every one of them is read.

- **`hookPolicies` is honoured** in `plan/hooks-projection.ts`, per enabled harness. `generate` is what the engine already did for the harnesses with a generated hooks file; `none` and `native` stop it writing that file and turn each contributing hook source into a drop naming the manifest; an absent entry is the default, so a manifest without the block projects exactly as before. The rule underneath it: **a policy governs what the engine writes, never what a vendor reads.** Claude Code reads `.claude/settings.json` whatever a manifest says, so a `native` line for it survives every policy, and what `none` switches off there is the installed-plugin merge into `.claude/settings.local.json`. A policy asking for a mechanism a harness does not have earns a plan warning rather than a false line. Two surfaces read the policy back so they cannot contradict it: `--allow-hooks` refuses to record a durable consent for hooks the policy suppresses, and the left-alone advice stops recommending a move that would change nothing.
- **The other four are retired**: kept in the schema as `unknown`, so an existing manifest still parses (`.strict()` would otherwise reject it, and `--enable` validates with this schema before writing a byte), and named one line at a time by `dorkos harness sync`. There is no config migration and there is not meant to be — the manifest is a per-repo file the engine does not rewrite, so the `--check` line IS the notice.

The scaffolder writes the three live keys and no longer plants four empty blocks nobody would ever be asked about again. The schema stays `.strict()`, so the derivable `sharedSkills` array this ADR removed is still rejected.

## Consequences

### Positive

- Preserves live single-source skill editing (symlinks), with full control over targets and fields.
- No fork-maintenance burden; the vendored slice is small, static, and MIT.
- The slimmed manifest removes ~half its entries, so every remaining line is genuine intent and drift is structurally reduced.
- An honest, always-emitted drop list (no silent omission) — the adoption gate for source-reading users.

### Negative

- We maintain the vendored maps and a periodic re-vendor checklist (the upstream surfaces move).
- We own and test the projector itself.
- The existing manifest needs a one-time slim + schema migration.
