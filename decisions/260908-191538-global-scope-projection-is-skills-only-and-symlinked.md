---
id: 260908-191538
title: Global-scope projection is skills-only and symlinked, and it deletes only what it can prove it wrote
status: accepted
created: 2026-09-08
spec: harness-sync-global
superseded-by: null
amends: 0303
---

# 260908-191538. Global-scope projection is skills-only and symlinked, and it deletes only what it can prove it wrote

## Status

Accepted (extracted from spec: `harness-sync-global`, DOR-1857; shipped in slices A1, A2 and A3 —
DOR-1922, DOR-1923 and DOR-1924).

**This ADR amends [ADR-0303](0303-harness-sync-multi-source-projection.md)** and does not replace it.
ADR-0303 stays `accepted`: its three source classes, its one drop list, its `provenance` tag and its
scope-matching rule all still govern. **One clause is narrowed:** "its **portable subset** (skills, hooks)
projects **automatically on install** to every enabled harness … scope-matched (project↔project,
global↔global)". At **global** scope the portable subset is **skills only**, hooks are refused, and the
projection is never automatic on install — it is asked for once and remembered. At project scope that
clause is unchanged.

The `affects` paths in `decisions/manifest.json` name the files slices A1 to A3 **create or change**; none
of `plan/global-projector.ts`, `apply/global-apply.ts` or `services/harness/agents-user-home.ts` exists yet.

## Context

ADR-0303 decided that a globally installed marketplace package projects to the harness global layers, and
nothing was ever built for it, because the projection engine is repo-relative end to end. So such a package
reaches Claude Code only when DorkOS drives it, through SDK injection, reaches no other agent tool at all,
and the one line a person sees about it names a global sync command that does not exist. Building the
global half means writing into a person's home directory, where five of the six agent tools read one shared
skills directory (`~/.agents/skills`) and Claude Code reads its own. But that directory already holds a
person's own files, another vendor's installer writes into it, and the engine's ownership test for a sweep
is two clauses (a symlink whose basename contains `__`) which on the machine this was measured on does not
distinguish DorkOS's links from symlinks the operator built by hand. SDK injection also delivers four kinds
this projection deliberately will not, so it cannot simply be replaced.

## Decision

We will project **skills only** at global scope, as **symlinks only**, into at most `~/.agents/skills` plus
Claude Code's own skills directory, and we will plan them from a **separate `buildGlobalPlan` entry point**
rather than a root discriminator on the existing planner, so a stage added later cannot reach a home
directory by default. We will generate, scaffold and merge nothing at user scope, and we will refuse
instructions, hooks, commands and MCP servers there, recording each reason in
`meta/harness-sync-capabilities.md`. We will require a **three-clause** ownership test before any removal:
the candidate is a symlink, its basename carries the `__` namespace, and its own link text resolves inside
`<dorkHome>/plugins` — read lexically, never through `realpath`, so a link an uninstall left dangling is
still recognisably ours. We will ask once, in the terminal, before the first write into a person's home,
remember the answer in `harness.global`, and skip the user tier with a printed reason on a deployment that
configured a boundary. We will **keep** SDK injection for global packages: it delivers skills, commands,
agents, hooks and MCP servers to a DorkOS-driven Claude Code session, this projection delivers only the
first, and the two therefore divide by audience rather than replacing one another.

## Consequences

### Positive

- "Installed globally" becomes true: a package's skills reach every agent tool the person named, in every
  project, including a bare `claude`, `codex` or `cursor` the person starts themselves.
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
- **Two delivery paths for one scope, permanently.** A DorkOS-driven Claude Code session gets a global
  package through SDK injection; every other agent tool and a bare `claude` get its skills through a
  symlink. Anyone reading either half has to know the other exists, and the reason they cannot be merged is
  that four of injection's five kinds are refused at user scope on purpose.
- **A DorkOS-driven Claude Code session may see a global package's skill twice**, once through the plugin
  and once through the user-tier link. The vendor documents loading one skill when the same target is
  reachable from more than one location, and both routes resolve to the same directory, so the duplicate is
  expected to collapse; that is not verified, it is a measured question on the H tier, and one condition in
  one planner skips the Claude Code link if the answer comes back wrong.
