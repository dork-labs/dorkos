# Founder Copy Draft: X Bio & GitHub Org Page

> DRAFT for Dorian to review and post himself. Nothing in this file has been published anywhere.
> No script, tool, or agent should post this copy to X or GitHub without Dorian's explicit go-ahead.
> Written 2026-07-11 alongside DOR-295 (pricing-philosophy page). Voice source: `meta/brand-foundation.md`
> and the `writing-for-humans` skill — no em dashes, no hype language, plain enough for a smart 9th
> grader, "you/your fleet" as the subject more often than "DorkOS/we."

## X (Twitter) bio

X profile bios cap at 160 characters. All four options below fit with room to spare.

**Option A — product-forward (128 chars), tagline last**

```
Building DorkOS: mission control for every coding agent you run. Claude Code, Codex, and OpenCode, one cockpit. You, multiplied.
```

**Option B — founder-forward (137 chars), leans on the origin story**

```
Self-taught in Section 8 housing. Shipped to 30M users. Now building DorkOS, so one person can run a fleet of AI agents. You, multiplied.
```

**Option C — shortest, tagline-first (118 chars), includes the repo link**

```
DorkOS: You, multiplied. Open source mission control for Claude Code, Codex, and OpenCode. github.com/dork-labs/dorkos
```

**Option D — plain founder line (116 chars)**

```
Founder, DorkOS. Open source mission control for every coding agent you run. One person, one fleet. You, multiplied.
```

**Recommendation:** Option A for launch week (it leads with what DorkOS does, not who built it — X bios get maybe two seconds of attention from a stranger). Switch to Option B once the "about/why" page (`07-website-changes.md` §4.3) ships and the origin story has somewhere to send people who click through.

## GitHub org page (`github.com/dork-labs`)

GitHub org profiles have a short "description" field (shown under the org name, similar length
budget to an X bio) and an optional longer profile README (`dork-labs/.github/profile/README.md`)
rendered on the org homepage.

### Short description field

```
Open source mission control for every coding agent you run. Building DorkOS.
```

(78 characters — well inside GitHub's field.)

### Org profile README (optional, longer form)

If Dorian wants the fuller org homepage treatment, a draft README body:

```markdown
# DorkOS

Mission control for every coding agent you run. One cockpit for Claude Code, Codex, and
OpenCode, so you can see what your agents are doing, hand them work on a schedule, and
step in only when they need you.

DorkOS is open source under the MIT license, and the whole free core stays that way. See
[dorkos.ai/pricing](https://dorkos.ai/pricing) for what that promise means in writing.

- Site: [dorkos.ai](https://dorkos.ai)
- Docs: [dorkos.ai/docs](https://dorkos.ai/docs)
- Install: `curl -fsSL https://dorkos.ai/install | bash`

Built by [Dorian Collier](https://doriancollier.com).
```

**Notes for Dorian:**

- Both surfaces avoid claiming anything not yet true. No mention of the desktop app or Obsidian
  plugin as finished (they're staged, per `AGENTS.md`'s product-state note) — if you want to name
  them, add "in beta" or similar rather than stating they work.
- "One person, one fleet" / "You, multiplied" is repeated deliberately across options so the bio
  and the site tagline read as the same voice on first click-through.
- None of this references pricing dollar amounts or tier names (Solo/Crew) — those aren't public
  yet per `11-revenue-model.md`'s R0/R1 staging, and a bio is the wrong place to pre-announce them
  anyway.
