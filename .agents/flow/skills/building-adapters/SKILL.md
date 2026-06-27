---
name: building-adapters
description: Guided procedure for generating and verifying a concrete /flow tracker adapter that conforms to the adapter contract. Use when building, porting, or scaffolding a tracker adapter for a new tracker (Jira, GitHub Issues, or another), or when /flow:init must produce one for an adopter. Teaches the generate-and-verify loop, maps the tracker onto the WorkItem model and the 16 capability verbs, then loops on validate-adapter.mjs until the conformance invariants pass.
---

# building-adapters - generate a conforming `/flow` tracker adapter

> **What this is.** The procedure an adopter (or `/flow:init`) follows to produce
> one concrete **tracker adapter**: the single tracker-aware component that lets
> the whole `/flow` engine run against a new tracker without changing one line of
> the generic layer. You map the adopter's tracker onto the generic `WorkItem`
> model and the 16 capability verbs, write the adapter, then prove it conforms.
>
> **This is a generate-AND-verify procedure, and the verify half is a gate.** An
> adapter is not done when it "looks right." It is done when `validate-adapter.mjs`
> returns a green verdict against a representative fixture. Generating without
> verifying is the failure mode this skill exists to prevent.

## The authoritative source

The contract you are conforming to is
[`.agents/flow/adapters/SPEC.md`](../../adapters/SPEC.md). **Read it first and keep
it open.** This skill is the _procedure_; the SPEC is the _contract_. Where they
ever disagree, the SPEC wins. The SPEC defines, and you will satisfy:

- the **`WorkItem` model** (SPEC section 2): the normalized shape every read verb
  returns, plus the hard rule (match on the state **category**, never the display
  name) and the label re-namespacing rule;
- the **16 capability verbs** (SPEC section 3): **8 reads** + **8 writes**, each
  with its must-do, durability, and graceful-degradation requirements;
- the **conformance invariants** `INV-1 .. INV-5` (SPEC section 4) that
  `validate-adapter.mjs` checks;
- the **contract version** (SPEC section 5) your adapter declares and re-validates
  against.

## When to use

Use this when you need a tracker adapter that does not yet exist: a new tracker
(Jira, GitHub Issues, or anything else), or a second access path for a tracker you
already support. Do **not** use it to _operate_ an existing adapter: to read or
write a tracker through an adapter that already conforms, route through that
adapter's own skill, not this one.

---

## The procedure

```
  ┌─ 1 READ the contract, pick a starting point
  │        (reference adapter, or from-scratch)
  │
  ├─ 2 MAP the tracker to the model
  │        state -> stateCategory  ·  native labels -> generic families  ·  native fields
  │
  ├─ 3 GENERATE the concrete adapter SKILL.md (all 16 verbs) into the adopter's skill home
  │
  └─ 4 VERIFY with validate-adapter.mjs  ──┐
             ▲                              │  verdict.ok ? -> DONE
             └────── fix the failed invariant, re-run ──┘  (loop until green)
```

Steps 1 to 3 produce a candidate. Step 4 is the gate that turns a candidate into a
conforming adapter. Expect to loop between 3 and 4.

---

### Step 1 - Read the contract, pick a starting point

1. Read [`.agents/flow/adapters/SPEC.md`](../../adapters/SPEC.md) end to end. You
   cannot map a tracker you have not measured against the contract.
2. Choose the closest starting point:
   - **Start from a reference adapter** when your access shape matches one. Two
     reference adapters live under
     [`.agents/flow/adapters/reference/`](../../adapters/reference/) and are the
     worked, concrete-tracker wiring for the _same_ tracker via two access paths:
     - `linear-mcp` - the in-session MCP path (an authenticated MCP server exposes
       tracker tools the agent calls directly).
     - `linear-composio` - the external-CLI path (a CLI bridges to the tracker when
       no in-session MCP server is available).

     Pick the one whose **transport** resembles your tracker's: an MCP server for
     your tracker resembles `linear-mcp`; a CLI or bare REST client resembles
     `linear-composio`. Copy its **structure** (the verb table, the normalization
     section, the durability rules), not its tracker strings.

   - **Start from scratch** for a tracker neither reference fits (for example Jira
     or GitHub Issues). You still copy the _shape_ of a reference adapter; you fill
     in your own tracker's wiring.

> **Do not copy tracker strings across.** A reference adapter names its own
> tracker's tools and slugs. Your adapter names _yours_. The thing you are reusing
> is the verb-by-verb structure and the normalization discipline, never the
> concrete API identifiers.

---

### Step 2 - Map the tracker to the model

This is the heart of the work. The adapter's core job is turning the tracker's
native representation into the generic shape. Produce two mapping tables and a
native-field plan. The fill-in worksheet is in
[`references/mapping-worksheet.md`](references/mapping-worksheet.md); the rules:

**2a. State -> `stateCategory`.** Every tracker workflow state maps to **exactly
one of five** categories: `backlog | unstarted | started | completed | canceled`.

- Match on the **category**, never the display name. Display names
  ("Triage", "In Progress", "Shipped") are team-customizable and break the moment
  a team renames a state. Carry the display name as `stateName` for rendering only.
- A holding or un-triaged state (an item not yet classified) maps to **`backlog`**:
  it is non-terminal, so it lists and recovers like any open item.
- **Never invent a sixth category.** The enum has exactly five values. An
  un-triaged item is held out of dispatch by the **absent `agent/ready` label**,
  not by a special category.

**2b. Native labels -> generic families.** The engine matches **literal,
namespaced** label strings. Map the tracker's native labels onto the generic
families before placing them on `labels[]`:

- `agent/*` - the durable disposition state machine (`agent/ready`,
  `agent/claimed`, `agent/completed`, `agent/needs-input`). `agentDisposition` is
  derived from this family.
- `stage/*` - the active spine-stage projection.
- `type/*` - the work type (`type` is derived from this family; exactly one).
- Any other `family/leaf` an adopter's stages introduce.

If the tracker stores a label as a **bare leaf** (for example `ready`) or under a
tracker-specific grouping, you **must** re-namespace it to the generic family form
(for example `agent/ready`), **or the engine silently fails to match it**. This is
a real normalization trap, not cosmetic. Build the leaf-to-family map from the
tracker's label list and apply it in every read verb.

**2c. Native fields.** `priority` and `size` are **native fields, never labels**.
Map them, plus `assignee`, the typed `relations` graph, and `createdAt`, from the
tracker's native fields. **A missing optional field is `undefined` (neutral),
never a fabricated value** - neutral is not "lowest priority" or "smallest size".
Read relations only from the tracker's **typed** relation graph, never by parsing
description prose; a missing graph degrades to "no known blockers" (neutral),
never to "blocked".

---

### Step 3 - Generate the concrete adapter SKILL.md

Write the adapter as a skill into the adopter's skill home:
`.agents/flow/skills/<tracker>-adapter/SKILL.md` (the harness symlinks it into the
adopter's `.claude/skills/`). It must contain:

1. **Frontmatter.** `name: <tracker>-adapter` and a `description` that triggers
   whenever a stage skill or the loop needs to read or write the tracker.
2. **The one rule, stated up top.** _All_ `/flow` tracker I/O lives in this
   adapter. No other flow skill or command may contain one of this tracker's API
   strings. The adapter is the **single audit surface** for every read and write.
3. **The access path(s).** How the adapter reaches the tracker (MCP tools, a CLI,
   or a REST client), auth, and any primary plus fallback path.
4. **The `WorkItem` normalization shape** with your **2a / 2b / 2c** mappings
   inlined, so a reader sees exactly how each native field becomes a generic one.
5. **All 16 verbs.** A table or section per verb binding it to the concrete
   tracker call, with its **durability** and **graceful-degradation** notes. Use
   [`references/verb-implementation.md`](references/verb-implementation.md) as the
   per-verb checklist - implement **every** verb; a partial adapter does not
   conform. The two universal degradation rules:
   - **A read that cannot reach the tracker MUST throw**, never return `[]`. Empty
     is a real signal ("checked, nothing matched"); a throw is "could not check".
   - **A write that fails MUST surface loudly and never report success.** The
     `agent/*` labels are the only recoverable state; a false success is
     unrecoverable.
6. **The declared contract version** (SPEC section 5): export a `CONTRACT_VERSION`
   constant or a manifest field naming the contract version you generated against,
   so `validate-adapter.mjs` can check the declaration and so drift is caught at
   validation time on a future contract bump.

---

### Step 4 - Verify with the conformance harness (the gate)

Build a **fixture**: a JSON file of the normalized `WorkItem`s your read verbs
return, chosen to exercise the invariants (at minimum: one item per state
category, both an `agent/ready` and a not-ready item, and at least one relation
that resolves in-set plus one that is terminal/out-of-set). Then run the harness:

```bash
node scripts/validate-adapter.mjs --fixture <path-to-your-fixture.json>
```

The harness reads JSON in and prints a JSON **verdict**:

```jsonc
{ "ok": true,  "failures": [] }
// or
{ "ok": false, "failures": [ { "invariant": "INV-4", "detail": "labels[] contains bare leaf 'ready'; expected re-namespaced 'agent/ready'" } ] }
```

- **Exit code `0`** means the verdict is `ok` (pass). **Nonzero** means at least
  one invariant failed (fail). Script the gate on the exit code.
- Each failure names the **invariant id** (`INV-1 .. INV-5`) and a human `detail`.

**The loop:** run the harness, read each failed invariant, fix the _mapping that
produced it_ in the adapter, then re-run. Repeat until `ok` is `true`. The adapter
is **not done until the verdict is green.** What each invariant means and the
usual cause:

| Invariant | Asserts                                                                                                                               | Usual fix                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **INV-1** | Every `stateCategory` is one of the five; a holding state maps to `backlog`; no sixth category.                                       | Fix the state -> category table (2a); never emit a tracker-specific category.                                  |
| **INV-2** | Required fields present and correctly typed; optionals absent or correctly typed; a missing optional is `undefined`, not fabricated.  | Stop defaulting a missing `priority`/`size` to `0`/smallest; emit `undefined`.                                 |
| **INV-3** | Relation references are human-key `identifier`s, not native ids; each `blockedBy` resolves in-set or is provably closed.              | Emit relations as `identifier`s; stop leaking native ids; treat out-of-set as non-blocking.                    |
| **INV-4** | Labels are re-namespaced into the generic families (`agent/*`, `stage/*`, `type/*`).                                                  | Apply the leaf-to-family map (2b); a bare leaf like `ready` fails.                                             |
| **INV-5** | Readiness is the literal `agent/ready` label; `getEligibleWork`/`getProjectWork` return the full **candidate** set, not pre-filtered. | Express readiness only as `agent/ready`; do **not** pre-filter to ready-only (it breaks starvation detection). |

Full troubleshooting, fixture construction, and the deliberately-failing negative
cases that prove the harness bites are in
[`references/conformance-harness.md`](references/conformance-harness.md).

> **INV-5 trap.** `getEligibleWork()` is named "eligible" but returns
> **candidates**: items carrying `agent/ready` **plus** dispatchable items that
> lack it. The engine's eligibility pass applies the `agent/ready` gate, not the
> adapter. An adapter that pre-filters to ready-only items passes a naive read but
> breaks the loop's ability to tell **done** (nothing shapeable) from **starved**
> (shapeable work waiting behind the gate). Return the full candidate set.

---

## Definition of done

An adapter is done only when **all** of these hold:

- [ ] Read [`.agents/flow/adapters/SPEC.md`](../../adapters/SPEC.md) and chose a
      starting point (a reference adapter or from-scratch).
- [ ] State -> `stateCategory` table complete; only the five categories; holding
      state mapped to `backlog`.
- [ ] Native-label -> generic-family map complete; `labels[]` carries `agent/*`,
      `stage/*`, `type/*` (no bare leaves).
- [ ] `priority`/`size`/`assignee`/`relations`/`createdAt` mapped from native
      fields; missing optionals are `undefined`, never fabricated.
- [ ] **All 16 verbs** implemented (8 reads + 8 writes) with their durability and
      degradation notes; reads throw on unreachable, writes never report a false
      success.
- [ ] The adapter is the single audit surface: no tracker API string lives in any
      other flow skill or command.
- [ ] `CONTRACT_VERSION` declared and matches the SPEC's current version.
- [ ] `node scripts/validate-adapter.mjs --fixture <fixture>` returns a verdict
      with `ok: true` and exit code `0`.

---

## References

- [`references/mapping-worksheet.md`](references/mapping-worksheet.md) - fill-in
  tables for state -> category and native-label -> generic-family, the native-field
  plan, and a generic worked example.
- [`references/verb-implementation.md`](references/verb-implementation.md) - the
  per-verb checklist for all 16 verbs (must-do, durability, degradation), generic
  and tracker-neutral.
- [`references/conformance-harness.md`](references/conformance-harness.md) - the
  `validate-adapter.mjs` interface, fixture construction, the verify loop, and
  per-invariant troubleshooting with negative cases.
