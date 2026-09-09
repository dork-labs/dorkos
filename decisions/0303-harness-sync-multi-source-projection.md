---
number: 303
title: Harness Sync is a multi-source projector — marketplace plugins project automatically, agent-native assets adopt explicitly
status: accepted
created: 2026-06-29
spec: harness-sync
superseded-by: null
---

# 303. Harness Sync is a multi-source projector — marketplace plugins project automatically, agent-native assets adopt explicitly

## Status

Accepted (extracted from spec: harness-sync — installed-plugin projection and `provenance` shipped in `@dorkos/harness`; the explicit `dorkos harness adopt` verb shipped with DOR-1853, under the amendment below)

**One clause is narrowed at GLOBAL scope by**
[260908-191538](260908-191538-global-scope-projection-is-skills-only-and-symlinked.md) (Global-scope
projection is skills-only and symlinked). The clause: "its **portable subset** (skills, hooks) projects
**automatically on install** to every enabled harness … scope-matched (project↔project, global↔global)".

At global scope the portable subset is **skills only** (hooks, commands, instructions and MCP servers are
refused at user scope, each with its reason recorded in `meta/harness-sync-capabilities.md`), and the
projection is **not automatic on install**: it is asked for once and remembered in `harness.global`. The
related Negative bullet "the projector must understand … scope mapping" is now understated rather than
wrong, and reads as history.

**At project scope this clause is unchanged**, and so is everything else here: three source classes, one
engine, one drop list, a `provenance` tag on every action, projections ephemeral and gitignored, adoption
explicit. That is why this ADR stays `accepted` rather than `superseded`.

**The THIRD source class's clause is widened by**
[260909-085610](260909-085610-adoption-is-explicit-everywhere-and-automatic-only-behind-an-allowlist.md)
(Adoption is reported everywhere, explicit by one command, and automatic only behind an allowlist
where DorkOS owns the directory). The clause: "(3) **agent-native** assets — promoted to canonical
only via an **explicit, reviewable `dorkos harness adopt`** (skills + instructions in v1), **never
automatically**".

Three things change. An asset nobody has adopted is **reported** in every sync and boot summary
rather than left to be noticed. The explicit verb moves **one skill at a time**, with a frozen
refusal and a way out for each case it will not. And the move **is** automatic in the two directories
DorkOS owns — an agent home under `<dorkHome>/agents`, and a room worktree — off by default there
too, and behind an allowlist of the agentskills.io base fields when it is on. The clause's other half
is unchanged: instructions stay explicit, and hook and command adoption stay deferred as lossy.

**`adopted` as a standing `Provenance` value is RETIRED.** Nothing ever produced it, and it was wrong
in a way that would have surfaced the moment something did (`isEphemeralProvenance('adopted')`
returns `true`, which would gitignore a skill that lands in the committed canonical layer). The third
source class survives as an **act**: adoption moves a skill into the authored root, and what the act
produces is an `authored` skill.

Two Consequences bullets below are narrowed with it. "Adoption is explicit and reviewable, so the
canonical source never silently absorbs a foreign asset" still holds for every path a person takes,
and is replaced by an allowlist where DorkOS is the author. "`adopt` needs per-source importers and a
review UX" is smaller than it reads: skills only, one at a time, one union of documented skill roots,
and no importer per source.

**Everything else here is unchanged**, which is why this ADR stays `accepted` rather than
`superseded`: three source classes, one engine and one drop list, a `provenance` tag on every action,
the scope-matching rule, and the treatment of installed packages all still govern as written.

## Context

Harness Sync as first specified projected only the repo's _authored_ canonical source (`.agents/`), but two other kinds of agent files exist on disk and a user wants them in every harness too. Marketplace plugins install to `<scope>/plugins/<name>` (`~/.dork/plugins` global or `<project>/.dork/plugins`) and today reach only the DorkOS-driven Claude runtime, via the SDK `plugins` array — there is **no** filesystem bridge to Codex/Cursor/OpenCode. Separately, users have assets installed natively by an agent (skills in `.claude/`, rules in `.cursor/`) that are stranded in that one harness. The vendored-maps decision (ADR-301) means we own the projector, so adding source roots is our choice, not a library constraint.

## Decision

We will make Harness Sync a **multi-source projector** over three source classes with one engine, one drop list, and a `provenance` tag on every projection action: (1) **authored** `.agents/` (committed); (2) **marketplace-installed** `.dork/plugins/*` — its **portable subset** (skills, hooks) projects **automatically on install** to every enabled harness, with projections **ephemeral/gitignored**, scope-matched (project↔project, global↔global), and DorkOS-only parts (extensions/adapters) dropped; (3) **agent-native** assets — promoted to canonical only via an **explicit, reviewable `dorkos harness adopt`** (skills + instructions in v1), never automatically. We do **not** change where the marketplace installs. Slash-command _triggers_ stay Claude-only while their _behavior_ travels everywhere as a skill; hooks project to every harness that has a hook system (Gemini is the lone drop).

## Consequences

### Positive

- "Install once, works in every harness" for marketplace plugins, reusing `@dorkos/marketplace`'s `installed-scanner` — no change to the install machinery.
- One engine + one honest drop list across authored, installed, and adopted sources; `provenance` cleanly separates committed from ephemeral projections.
- Adoption is explicit and reviewable, so the canonical source never silently absorbs a foreign asset (honors the conflict rule). _Narrowed by 260909-085610:_ still true of every path a person takes, and replaced by an allowlist read from the frontmatter as the author wrote it in the two directories where DorkOS is the author.

### Negative

- The projector must understand the plugin layout, a collision/namespacing policy, scope mapping, and ephemeral-vs-committed gitignore — more surface than single-source projection.
- `adopt` needs per-source importers and a review UX; hook/command adoption is lossy and deferred. _Narrowed by 260909-085610:_ smaller than it reads — skills only, one at a time, over one union of documented skill roots, with no importer per source.
- Requires fixing the latent gap where project-local `.dork/plugins/` is not gitignored.
