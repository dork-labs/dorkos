# Codifying the UI/UX Audit — Plan v3 (converged)

(v1 → r1: 3 blocking accepted. v2 → r2: claim-semantics fence refuted on flow's actual texts and replaced with the reviewer's blockedBy mechanism; §2c pushback adjudicated in my favor with two riders. v3 incorporates everything; no open disagreements.)

**Goal:** unchanged — turn the September 2026 audit programme into a repeatable capability: DorkOS continually audits and improves its own UI; marketplace-eventual.

## 1. What we're codifying — unchanged from v1 (six phases + operational knowledge)

## 2. Shape: standalone plugin, flow-aware — **direction survives review; seams redesigned**

Option C stands (ADR-0297 precedent; programme generator ≠ work-item spine). Three structural corrections:

### 2a. **[R1-B1, mechanism corrected in R2] The ownership contract: the blockedBy fence**

R2 refuted v2's claim-semantics fence on flow's own texts: groom's plan-level approval arms label changes wholesale (a well-formed audit finding satisfies every readiness condition _by construction_ — the charter's validity rules are what qualify it), and borrowing `agent/*` claim labels makes tending/drain treat audit items as flow's own **orphaned work to re-adopt** — the fence inverted. The plugin therefore **never writes `agent/*` labels.**

**Adopted mechanism (reviewer's counter-proposal):**

- Every `/ui-audit:run` / `:pulse` emission creates one per-run **`type/meta` item — "promotion decision for audit run <date>"** — and every emitted finding-batch item carries a **`blockedBy` edge to it**. `source/audit` label rides along as provenance only (explicitly not a fence).
- Triple fence, zero flow modification: (1) an open blocker mechanically fails flow's readiness condition (c), so triage/groom cannot honestly arm it; (2) the meta item hits groom's own "meta, never ready" rubric; (3) flow's dispatch engine independently drops open-blocker items even if one were mis-armed.
- **Promotion = resolving the blocker, which IS the fork,** chosen per batch by the operator (or config default):
  - **flow path** — remove the edge; the item enters the normal lifecycle; the audit never touches it again.
  - **audit path** — `/ui-audit:execute` works items **still-blocked** (the fence stays up against flow the whole time) and closes them on merge.
- Flow absent: markdown ledger (`audits/runs/ui/<date>/backlog.md`), no contention exists.
- Residual risk, disclosed: groom _could propose_ closing the promotion-decision meta item as junk — but closures are the one class that always passes groom's itemized human gate with evidence, so the operator catches it there. And the meta item has an end-of-life: the close-out checklist closes it once every batch in its run is promoted or closed, so it never becomes the stale ledger groom sweeps at.

### 2b. **[R1-B2] Portability: prose is normative; scripts are local color**

- The marketplace package ships **prose procedures only** — the audit fan-out and the landing method written against the lowest common surface (spawn N agents however your harness spawns agents; run them sequentially if it spawns none). Flow's own script/prose line (deterministic JSON oracles = scripts; orchestration = prose) is adopted as-is; we ship zero orchestration scripts.
- This session's two Workflow scripts survive **in-repo only**, as non-normative reference implementations linked from the in-repo skill ("if your session has the Workflow orchestrator, these are known-good"), excluded from the package at graduation.
- **Demo-claim gate respected:** the package README claims bare-Claude-Code compatibility only after phase 5's validation step actually runs one scoped audit under bare CC (`claude --plugin-dir`). Until then, copy says "built for DorkOS sessions; other harnesses unverified."
- Sequential mode is documented as a first-class path, not a degraded one (one batch at a time is how a single-machine adopter should start anyway).

### 2c. **[R1-B3] No third orchestration home — upgrade the incumbent** (scoped pushback below)

- In-repo: **no new `landing-parallel-batches` skill.** The wave/collision/rebase/arm-verify/close-out playbook lands as an upgrade to the existing **`orchestrating-parallel-work`** skill (verified: same trigger territory, Agent-tool-based prose — also the portable substrate B2 wants). `contributing/parallel-execution.md` gets the same delta where it overlaps.
- The failure-mode library (six defect shapes + this run's additions) **upstreams into `REVIEW.md`**, where the automated PR reviewer compounds it on every PR — reviewer's best counter-proposal, accepted whole.
- **§2c adjudicated (R2):** conclusion confirmed, premise corrected. A dependency mechanism _does_ exist (`requires: ["<type>:<name>@<ver>"]` in the marketplace manifest, per contributing/marketplace-installs.md) — but it names marketplace **packages**, not in-repo skills, so it's inapplicable here and packaging the playbook now would be the premature extraction both sides rejected. The condensed landing section inside the plugin stands, with two riders: **(a)** it carries a provenance header naming the in-repo source, and graduation includes a **re-derive step** (ADR-0294's two-encodings-drift lesson); **(b)** the end-state is written down now: if a second non-UI programme wants the playbook, extract it to a `skill-pack` package and point both consumers at it via `requires:` — so the mechanism doesn't get re-discovered later.

## 3. Architecture (final)

**Plugin `ui-audit`** (naming decided at scaffold), following flow's migration model: incubate in-repo → **move** (not copy) at graduation, no in-repo twin remains.

### Committed operator artifact — **[OPERATOR, post-r3] `audits/<domain>.md` convention, not a root AUDIT.md**

- Operator veto on the root file: the repo audits many domains (ADRs, research, docs, backlog), and a UI-specific charter must not squat on the generic name. Replaced with a directory convention: the plugin scaffolds and reads **`audits/ui.md`**. Same skeleton as designed (lenses, rubric, validity rules, standing directives, ground-truth pointers — **[R1]** contents unchanged: generic lens library, repo specifics injected by init).
- **`audits/README.md`** holds the cross-domain preamble (directives true of everything: simplify, no-walls-of-text) that every domain charter inherits; the charter _skeleton_ is the generic artifact future domains (`audits/docs.md`, `audits/adrs.md`, `audits/harness.md`) reuse — and future audit plugins ship their lens libraries into the same convention instead of contending for one file.
- Root-visibility loss vs REVIEW.md analogy accepted: REVIEW.md is repo-wide, a domain charter isn't; discoverability restored by a one-line AGENTS.md pointer.

### Skills — **[R1] 4 → 2 + assets**

1. **`auditing-ui`** — scoping (full / lens / surface / diff), auditor + browser-leg procedure (the browser look-don't-touch safety rules folded in as a section — review found `browser-auditing-safely` would misfire against `browser-testing` at trigger time), synthesis + batch-grouping rules, charter management, the ownership contract from 2a. Prompt templates for auditors/synthesizer as skill assets, not skills.
2. **`orchestrating-parallel-work`** (upgraded incumbent, in-repo) — the landing playbook.

- Review-brief content → `REVIEW.md` + an asset template in `auditing-ui`.

### Commands (4, unchanged names, thinner semantics)

- `/ui-audit:init` — scaffolds `audits/ui.md` (+ `audits/README.md` **create-if-absent, never overwrite** — the preamble is shared with future audit plugins, none may clobber another's accretions); **[R1] captures a repo profile**: merge queue or plain merges? changelog fragments? worktree conventions? CI formatting gate? Tracker mode (flow-adapter / markdown-ledger). Landing guidance adapts to the profile (an adopter without a merge queue must not inherit arm-then-verify or bare `--auto`).
- `/ui-audit:run [scope]` — audit → report + batch plan + unarmed tracker items per 2a.
- `/ui-audit:execute [range]` — verifies the fence first (blocker intact, item unarmed), then the landing method; items stay blocked until closed on merge. In-progress visibility uses a plugin-namespace `audit/claimed` label — never flow's `agent/*`.
- `/ui-audit:pulse` — **[R1] diff-scoping corrected**: the diff scope covers surface-local lenses only (states, copy, responsiveness, overflow, motion on changed surfaces); whole-tree lenses (DRY, consistency, organization, componentization) are structurally incapable of diff-scoping and run only in the rotation (one whole-tree lens per pulse, 12-week cycle). Emits items; never executes. **[R2]** Diff stamps are tracked **per lens** (each lens's last-audited commit, not one global stamp). Pulse **degrades explicitly when the browser leg is unavailable** (no runnable app/port): it says so in the report and audits code-only, rather than silently narrowing. Pulse **dedups against open `source/audit` items and ages them**: a finding already filed is refreshed, not re-filed; a filed finding whose cited code no longer exists is flagged for closure.

## 4. Continuous loop — unchanged except pulse scoping above. **[post-r3]** Run log lives under the convention at `audits/runs/<domain>/<date>/` (overridable in the init repo profile) — the plugin owns `audits/`, whereas `plans/` is a DorkOS-repo convention adopters may lack, and pulse must reliably find per-lens diff stamps + rotation state. Charter + operational memory share one home, so future domains inherit both. The September run's `plans/ui-ux-audit-202609/` stays as history; the log convention starts at run 2. **[operator Q] `audits/` is COMMITTED, never gitignored** — worktrees only carry tracked files (a gitignored charter wouldn't exist where batch agents run), pulse's per-lens stamps must be durable across checkouts/machines, and the flow-absent ledger is the tracker of record. One exclusion rule in the convention: heavy artifacts (screenshots, videos) never enter `audits/` — session scratchpad only, referenced by description; run logs stay lean markdown. The `audits/ui.md` vocabulary line carries the `vocab-allow` marker (audits/ isn't in check-banned-words SCAN_TARGETS today, but write it guard-safe anyway).

## 5. Build plan (final)

| Phase | What                                                                                                                                                                                      | Notes                                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Upstream failure-mode library into REVIEW.md; upgrade `orchestrating-parallel-work` with the landing playbook                                                                             | smallest, highest-leverage, zero new surface **[R1 order]**                                                                               |
| 2     | `audits/ui.md` + `audits/README.md` + `auditing-ui` skill + 4 commands, dual-harness in-repo (**canonical copy in `.agents/skills/`**, projected per the syncing-agent-skills convention) | `/ui-audit:run full` prints a cost estimate before spawning (a full run is ~10M+ subagent tokens — the operator should consent knowingly) |
| 3     | Dry-run `/ui-audit:run lens:tokens` (cheap validation)                                                                                                                                    |                                                                                                                                           |
| 4     | `/ui-audit:pulse` on a DorkOS schedule, 2 weeks                                                                                                                                           |                                                                                                                                           |
| 5     | Graduate: `dorkos package init ui-audit --type plugin`; port; **bare-CC validation run**; validate; publish; delete in-repo originals (flow migration model)                              | demo-claim gate satisfied before any compat claim                                                                                         |

Each phase lands as a normal PR programme (worktrees, adversarial review pre-PR).

## 6. Resolved across rounds

- 4 skills → 2 + assets (r1). Charter placement: root AUDIT.md superseded post-r3 by operator veto → `audits/<domain>.md` convention (contents unchanged from r1; run logs at `audits/runs/<domain>/`). Diff-scoping split by lens class (r1), stamped per lens with browser-degrade + aging/dedup (r2). `landing-parallel-batches` never exists (r1). Ownership fence = blockedBy-to-meta-item, never `agent/*` (r2). Plugin self-containment via condensed section + provenance header + graduation re-derive + written extraction end-state (r2). Prose-only is a floor, not a ceiling: ADR-0298-style deterministic oracles (collision analysis, wave sequencing) may join later as JSON-in/JSON-out scripts — the one script shape flow's precedent blesses. Naming at scaffold time.

## 7. Open disagreements

None. Converged at r3.
