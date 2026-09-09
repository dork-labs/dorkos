# Harness Sync — adopt: ideation

**Status:** Complete (no re-ideation needed). **Date:** 2026-09-09. **Tracker:** DOR-1853.

## Where the ideation actually lives

This work was ideated in the capabilities audit, not here. Its input is **position D3** in
[`meta/harness-sync-capabilities.md`](../../meta/harness-sync-capabilities.md) §16 — "Adopt is
reported everywhere and automatic only where DorkOS owns the directory" — which was drafted, argued
across two rounds of adversarial review, and settled. Every sentence of D3 is a settled input to the
specification; this file exists so the SPECIFY stage has the artifact it expects and so a reader
knows where to look, not to re-derive a position that already has one.

Read, in this order:

- `meta/harness-sync-capabilities.md` §16 **D3** in full, and rows **SRC-07**, **SRC-10**, **SRC-11**,
  **SK-04**, **SK-07**, **SK-13**, **AP-15**, **VC-01**, **J-06**, plus §14 items 3 and 11.
- `plans/harness-sync-test-plan.md` line 10 of §11 (the PR this is), and the "Adopt tests, once D3
  lands" paragraph in §6.
- The tracker item **DOR-1853**, which restates D3's conclusion as the thing to build.
- `decisions/0303-harness-sync-multi-source-projection.md` — the clause this work amends.

## What D3 settled, restated as a list

1. **Report everywhere, in v1, DorkOS-owned directories included.** Every sync summary and every boot
   summary lists the `unmanaged (adoptable)` skills. Nothing moves on its own.
2. **`dorkos harness adopt <name>` moves one skill**, explicitly, from a harness-native skills root
   into `.agents/skills/<name>`, leaving a link behind so the harness that owned the old path still
   finds it.
3. **It refuses when `.agents/` is gitignored** (AP-15): the move would take the skill out of git for
   everyone who clones the project.
4. **It refuses, in a room worktree, one of the seven seeded pack names** (SRC-11): that path is
   hidden from `git status` there and is reaped.
5. **`harness.autoAdopt` defaults `false` everywhere** and is merely _permitted_ where DorkOS owns
   the directory — agent homes and room worktrees.
6. **When it is on, the guard is an allowlist**, never a denylist: move only a skill whose
   frontmatter holds nothing outside the agentskills.io base fields and whose body carries no
   `${CLAUDE_*}` token. Everything else is reported and never moved.
7. **Instructions stay explicit** (`CLAUDE.md` → `AGENTS.md`, IN-06). They are not in scope here.

## The reasons D3 gives, kept verbatim in shape

- A skill physically in `.agents/skills` is read natively by five harnesses, and a `drop` line has no
  power to un-expose it. An auto-move is therefore one-way and unrevocable.
- `manifest.claudeOnlySkills` cannot un-expose a moved skill, and per SK-04 it only fires after the
  move anyway.
- "`git status` shows a rename" is false for a directory (N deletions + N additions), and false twice
  when `.agents/` is gitignored, where a teammate's clone loses the skill outright.
- An agent is runtime-agnostic (`runtimeRegistry` binds a session, not an agent), so a skill
  auto-moved inside an agent home is exposed to that same agent's next Codex session.
- A frontmatter **denylist** of "Claude-only fields" is a guard somebody has to remember every time a
  vendor adds a field, and the failure direction of forgetting is "moved anyway". An allowlist
  inverts that to "adopts only what was recognised as safe".
- Claude-only-ness often lives in the **body** (`${CLAUDE_*}` tokens, `/reload-plugins`), which SK-07
  already knows and a frontmatter guard ignores.
- An agent home has no `git status` and no reader; the boot pass runs unattended, so the one
  mitigation a move relies on — visibility — is weakest exactly there.

## What this stage does not have to decide

The status surface (D6) already exists: `buildHarnessStatus()`, `GET /api/harness/status`,
`POST /api/harness/sync` and the agent profile's Skills page shipped in DOR-1891…1896, and the
`unmanaged (adoptable)` row is drawn today with the advice line and no button. D3 required the status
surface before the flag, and that prerequisite is met.

## Next step

SPECIFY → [`02-specification.md`](02-specification.md).
