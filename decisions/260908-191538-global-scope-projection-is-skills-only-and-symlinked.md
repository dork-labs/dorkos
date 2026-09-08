---
id: 260908-191538
title: Global-scope projection is skills-only and symlinked, and it deletes only what it can prove it wrote
status: proposed
created: 2026-09-08
spec: harness-sync-global
superseded-by: null
amends: 0303
---

# 260908-191538. Global-scope projection is skills-only and symlinked, and it deletes only what it can prove it wrote

## Status

Proposed (extracted from spec: `harness-sync-global`, DOR-1857).

**This ADR amends [ADR-0303](0303-harness-sync-multi-source-projection.md)** and does not replace it.
ADR-0303 stays `accepted`: its three source classes, its one drop list, its `provenance` tag and its
scope-matching rule all still govern. **One clause is narrowed:** "its **portable subset** (skills, hooks)
projects **automatically on install** to every enabled harness … scope-matched (project↔project,
global↔global)". At **global** scope the portable subset is **skills only**, hooks are refused, and the
projection is never automatic on install — it is asked for once and remembered. At project scope that
clause is unchanged.

## Context

ADR-0303 decided that a globally installed marketplace package projects to the harness global layers, and
nothing was ever built for it. The projection engine is repo-relative end to end: `project(repoRoot)` joins
every read against the repo root, `applyPlan(repoRoot, plan)` resolves every target against it, and the
orphan sweep scans two repo-relative directories. A globally installed package therefore reaches Claude Code
only when DorkOS is driving it, through SDK injection, and reaches no other agent tool at all; the one line a
person sees about it names a global sync command that does not exist. A globally installed skill that
declares a schedule is worse than dropped, because nothing says anything about it at all.

Building the global half means writing into a person's home directory, and two facts about real machines
decide how. Five of the six agent tools DorkOS supports read one shared user-level skills directory
(`~/.agents/skills`), and Claude Code reads its own; that is the same single fact the whole project-scope
design rests on, one directory up. But a home directory already holds a person's own files under those exact
names, another vendor's installer writes into one of them, and the engine's existing ownership test for a
sweep is two clauses — a symlink whose basename contains `__` — which on the machine this was measured on
would not distinguish DorkOS's links from symlinks the operator had built by hand.

## Decision

We will project **skills only** at global scope, as **symlinks only**, into at most `~/.agents/skills` plus
Claude Code's own skills directory, from a **separate `buildGlobalPlan` entry point** rather than a root
discriminator on the existing planner, so a stage added later cannot reach a home directory by default.
Nothing is generated, scaffolded or merged at user scope, and instructions, hooks, commands and MCP servers
are refused there, each with its reason recorded in `meta/harness-sync-capabilities.md`. A removal requires a
**three-clause** ownership test: the candidate is a symlink, its basename carries the `__` namespace, **and**
its own link text resolves inside `<dorkHome>/plugins` — evaluated lexically, never through `realpath`, so a
link left dangling by an uninstall is still recognisably ours. The first write into a person's home is asked
for once, in the terminal, and the answer lives in `harness.global` in `~/.dork/config.json`; a deployment
with an explicitly configured `DORKOS_BOUNDARY` skips the user tier and says so rather than widening the
boundary. Once the projection covers global scope, the SDK-injection path for global packages is deleted, as
ADR `260706-192819` already did for project scope.

## Consequences

### Positive

- "Installed globally" becomes true: a package's skills reach every agent tool the person named, in every
  project, for a bare CLI as well as a DorkOS session.
- A globally installed skill that declares a schedule runs, because the same machinery links it into
  `<dorkHome>/skills`, the one root the scheduler watches.
- The three-clause test makes ownership structural rather than a naming habit, so a person's own symlinks in
  the same directories are safe by construction and not by luck.
- The refusals are recorded as decisions with reasons, so four contract rows stop reading as gaps.
- Two properties (no `generate` in a global plan; every global target inside a declared root) hold the rules
  by test rather than by discipline, which is what keeps a later stage from quietly losing them.

### Negative

- The engine grows a second entry point, a second apply and a second sweep, and `ProjectionAction` grows a
  scope discriminator that every reader of `target` now has to respect.
- Resolving `~/.agents` needs a sixth carve-out from the `os.homedir()` ban, with the ESLint, rule-file and
  guard-script edits that come with it.
- Two of the five agent tools document a skill-name rule that `<pkg>__<name>` breaks, so the reach may be
  four of six until a naming change is decided separately.
- A sweep in a home directory has no `git status` and no reader, so the mitigation is disclosure (every path
  printed before removal) rather than reviewability.
- The same package installed at both scopes is reported and never resolved, because the agent tools disagree
  about which copy wins and DorkOS has no power over a directory they read on their own terms.
