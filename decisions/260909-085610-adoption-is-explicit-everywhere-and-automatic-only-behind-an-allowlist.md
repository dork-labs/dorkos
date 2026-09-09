---
id: 260909-085610
title: Adoption is reported everywhere, explicit by one command, and automatic only behind an allowlist where DorkOS owns the directory
status: proposed
created: 2026-09-09
spec: harness-sync-adopt
superseded-by: null
amends: 0303
---

# 260909-085610. Adoption is reported everywhere, explicit by one command, and automatic only behind an allowlist where DorkOS owns the directory

## Status

Proposed (extracted from spec: `harness-sync-adopt`, DOR-1853). It stays `proposed` until the
implementation lands. The Decision below covers slices 1 to 3 of that spec — the report, the explicit
verb, and `harness.autoAdopt` behind its allowlist — so the pull request that ships **slice 3** is
the one that flips it to `accepted`. Slice 4 (the route and the page button) is a surface for the
same decision and changes nothing here.

**This ADR amends [ADR-0303](0303-harness-sync-multi-source-projection.md)** and does not replace it.
ADR-0303 stays `accepted`: its three source classes, its one engine and one drop list, its
`provenance` tag, its scope-matching rule and its treatment of installed packages all still govern.
**One clause is widened and one term inside it is retired:** "(3) **agent-native** assets — promoted
to canonical only via an **explicit, reviewable `dorkos harness adopt`** (skills + instructions in
v1), **never automatically**". That clause held that adoption is explicit and nothing more; it did
not say what a person is told about an asset nobody adopts, and it treated "never automatically" as
absolute. Both change here: adoption is **reported everywhere** by default, it is **explicit by one
command** for one skill at a time, and it is **automatic only behind an allowlist, and only in the
directories DorkOS owns**. The clause's other half is unchanged — instructions stay explicit, and
hook and command adoption stay deferred as lossy.

The term retired is **`adopted` as a standing `provenance`**. ADR-0303 gave the third source class a
`Provenance` value; nothing ever produced it, and it was wrong in a way that would have surfaced the
moment something did (`isEphemeralProvenance('adopted')` returns `true`, which would gitignore a
skill that lands in the committed canonical layer). The third source class survives as an **act**:
adoption moves a skill into the authored root, and what comes out the other side is an `authored`
skill.

## Context

A skill an agent writes into a harness's own folder — a real directory at
`.claude/skills/deploy-checklist/` — is read by four of the six agent tools and invisible to the
other two for ever. ADR-0303 named `dorkos harness adopt` as the answer and it was never built, so
`Provenance` carried a value nothing produced, the Skills page printed advice with no action under
it, and the drop list told people to move a folder by hand. A first design for the missing verb
proposed moving those directories automatically; two rounds of adversarial review took it apart.
Once a directory is physically in `.agents/skills`, five tools read it and a `drop` line cannot
un-expose it, so an auto-move is a one-way, unrevocable exposure of exactly the skills somebody kept
in one tool on purpose. `git status` shows a directory move as N deletions plus N additions rather
than a rename, and shows nothing at all when `.agents/` is gitignored — where the move takes the
skill out of git for everybody who clones the repository. An agent is runtime-agnostic, so a skill
auto-moved inside an agent home reaches that same agent's next Codex session. And an agent home has
no `git status` and no reader, so the one mitigation an auto-move leans on is weakest exactly where
the unattended pass runs.

## Decision

We will **report** every skill that lives only in one agent tool's folder, in every sync summary and
every unattended boot summary, naming the tools that cannot see it — computed from each vendor's own
documented read paths rather than written down — and the exact command that would move it. We will
ship `dorkos harness adopt <name>`, which moves **one** skill directory into `.agents/skills/<name>`
in a single `rename(2)` and realizes the projection the planner already plans for that skill at the
old path, so the next `--check` is clean by construction; a failure restores, and a crash between the
two leaves the skill whole at the canonical root with a projection the next sync makes. We will
**refuse**, each with one plain sentence naming the way out, when `.agents/` is gitignored, when a
room worktree's reserved pack names are asked for, when the target is occupied, when the source
is itself a symlink, when a path on the way is hostile, and when the skill fails the allowlist —
with `--claude-only` recording the placement as deliberate rather than a `--force` that would move it
anyway. We will add `harness.autoAdopt`, defaulting **`false` everywhere** and read at exactly two
call sites, both of which have already established that DorkOS owns the directory they stand in — an
agent home under `<dorkHome>/agents`, and a room worktree — so a `true` anywhere else is inert by
construction rather than by a check. And when it is on, the guard is an **allowlist**, read from the
frontmatter **as the author wrote it**: a skill moves only when its frontmatter holds nothing outside
the agentskills.io base fields and its body carries no `${CLAUDE_…}` token. Everything else is
reported and never moved.

## Consequences

### Positive

- The gap ADR-0303 named and left open is closed: an agent-native skill has a path back to canonical,
  and until somebody takes it, every surface says so in the same sentence.
- The failure mode is inverted. A denylist of "Claude-only fields" has to be extended every time a
  vendor adds one, and the cost of forgetting is a file moved anyway; an allowlist's cost of
  forgetting is a file reported and left alone. That is the only version that survives a vendor
  shipping a field on a Tuesday.
- The allowlist reads the raw frontmatter, so a `hooks:` block the schema strips — a real thing Claude
  Code runs the moment a skill is invoked — cannot pass a guard built on the parsed object.
- Automation is confined to the two directories where DorkOS is the author, and it is off there too
  until somebody says otherwise, so the default posture of every install is unchanged.
- The link left behind is the planner's own action realized by the apply stage every sync uses, so it
  inherits the Windows junction, the occupant checks and the clone-without-symlinks behaviour instead
  of repeating them, and "the next sync already matches" is a property rather than a promise.
- Retiring the `adopted` provenance removes a value that could only ever have been wrong, and shrinks
  a `satisfies` table the compiler holds honest.

### Negative

- **The move is still one-way in the thing that matters.** Adopting shares a skill with five tools,
  and nothing un-shares it — `manifest.claudeOnlySkills` only governs a skill that stayed put. The
  mitigation is that every path to the move is a person's decision or an allowlist, never a default.
- **The allowlist is narrow enough to be annoying.** A perfectly portable skill carrying
  `display-name:` is refused by `autoAdopt` and has to be adopted by hand. That is deliberate, and it
  will read as fussy to somebody who knows their own file is fine.
- **An allowlist ages in the other direction too.** When a vendor adopts one of Claude Code's fields,
  the field stays off the list until somebody notices, and skills that could travel are reported
  instead of moved. Failing closed has a cost and this is it.
- **A crash mid-adopt leaves work for the next sync.** The skill is whole and nothing is lost, but
  Claude Code does not see it until something projects again — which is seconds in a running DorkOS
  and a manual command in a bare terminal.
- **The engine grows a module, a CLI subcommand, a route and a config leaf**, and the config leaf
  needs a verdict in three separate total registries before the build is green.
- **Two documents were wrong and are corrected in the same work**: the capability contract's J-06 row
  still described the pre-review draft of this position, and the test plan's seeded defect for this
  line has been green since the status surface shipped.
