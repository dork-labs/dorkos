---
title: 'ADR corpus health audit and lifecycle redesign (2026-08)'
date: 2026-08-06
type: audit
status: active
tags: [adrs, decisions, documentation, lifecycle, orchestration, harness]
---

# ADR Corpus Health Audit and Lifecycle Redesign

**Question:** The repo has 365 active ADRs (+87 archived). Many are suspected superseded, outdated, or contradictory, while ~1,600 references across code, guides, and specs depend on them. How healthy is the corpus really, and what process keeps it healthy?

**Method:** Mechanical scans (manifest integrity, dead-path detection, citation mapping) + a stratified semantic audit of 36 accepted ADRs by three parallel Sonnet agents verifying each decision against the current codebase + external research on industry ADR lifecycle practice.

---

## 1. Findings: the corpus

### Scale and shape

- 365 ADRs in `decisions/manifest.json`; 87 more already in `decisions/archive/`.
- Status distribution: **332 accepted**, 19 superseded, 6 deprecated, 5 proposed, 2 rejected, 1 draft.
- Two creation waves: Feb–Mar 2026 (156) and Jun–Jul 2026 (152). The Feb–Mar wave predates the runtime abstraction, communities, and the marketplace redesigns.

### Structural integrity: good

- `adr-drift-check.mjs` is clean (no orphans, collisions, or missing files).
- Exactly one broken supersession link: **ADR-0027** has `status: superseded` but `supersededBy: null` (its successor is 0029, stated only in 0029's body).
- Frontmatter statuses and manifest statuses agree corpus-wide.

### Semantic integrity: the real problem

Stratified sample of 36 accepted ADRs, each verified against source by an auditor agent:

| Era            | Current      | Drifted      | Obsolete    |
| -------------- | ------------ | ------------ | ----------- |
| Feb 2026 (12)  | 5            | 6            | 1           |
| Mar 2026 (12)  | 9            | 1            | 2           |
| Apr–Aug (12)   | 8            | 3            | 1           |
| **Total (36)** | **22 (61%)** | **10 (28%)** | **4 (11%)** |

Extrapolated to 332 accepted ADRs: **~35 are obsolete** (decision reversed or removed) and **~90 are drifted** (core decision holds; named mechanisms, files, or scope have materially changed) — while every one of them still reads `status: accepted`.

Confirmed obsolete examples: 0018 (server-side SSE subject filtering — inverted by the global `/api/events` multiplexed stream), 0105 (header as agent identity surface — component deleted, replaced by `AgentIdentityChip`), 0250 (PackageCard compact variant — production now uses the `GalleryCard` the ADR explicitly rejected), 0259 (legacy relay subject sunset — none of its three phases were ever implemented and the motivating heuristic was removed by other means).

### The dominant failure mode: undocumented drift

In almost every non-current case, the codebase moved on **without a successor ADR**. Nobody decided to abandon ADR-0259's sunset plan; the pain point evaporated and the plan silently died. Product renames (Pulse → Tasks) similarly rippled through old ADRs with no record.

Root cause: **`accepted` is write-once in practice.** `/adr:review` only drains the `proposed` backlog (5 items). No mechanism has ever re-examined an accepted ADR. The status field can only rot.

### Consumption: citations, not bulk reads

- ~1,589 ADR references in code + guides + rules (excluding specs); 114 distinct ADRs cited.
- **Only 104 of 332 accepted ADRs are load-bearing** (cited from code, guides, docs, or harness rules). The other 228 are never referenced outside `specs/` and `decisions/` — pure history.
- **99 source files cite superseded ADRs.** 45 of them cite ADR-260713-143958 alone — the partial supersession that `writing-adrs` acknowledges is mislabeled (`status: superseded` while its Plane-1/Plane-2 split still governs live telemetry code) but rules "do not fix." That carve-out is the single largest source of misleading citations in the repo.
- Dead-path signal is weak: only 12 of 332 accepted ADRs cite now-missing paths (5 with _all_ paths dead: 0296, 0271, 0156, 0068, 0048). Paths outlive decisions, so path-checking alone cannot detect rot — semantic verification is required.

### Inflow calibration

365 ADRs in six months includes micro-decisions that fail the significance rubric's "project-wide impact" test in hindsight (0250 PackageCard variant, 0153 indicator placement, 0163 zero-DOM conditional rendering). The extraction bar (score ≥ 2 of 4) admits single-feature UI implementation details.

---

## 2. Findings: industry practice (external research)

Full agent report highlights; primary sources: Nygard/Cognitect, MADR, adr-tools, AWS Prescriptive Guidance, Backstage, UK MOJ/GOV.UK runbooks, log4brains, adrkit, ECSA'24 action-research study, 2026 agent-optimized-ADR writing.

1. **Near-unanimous: ADRs are an immutable, append-only log.** Never rewrite accepted bodies; supersede with a new record. Status lines and typo/link fixes are the only permitted edits. Nobody advocates living-document ADRs at scale.
2. **The scale answer is layering, not editing**: keep the log immutable and maintain a separate living current-state surface (architecture haiku / arc42 / C4 — for DorkOS: `contributing/` + `AGENTS.md`, which already play this role).
3. **Two relation types, not one**: `supersedes` (full replacement; old status flips) vs **`amends`** (partial change; old ADR stays accepted and gains a pointer). GOV.UK encodes Amended as a first-class status (♻️); MADR embeds successor ids in the status string. This is the industry's answer to the partial-supersession problem `writing-adrs` currently handles with prose conventions.
4. **Staleness practice is date-based and human-triggered everywhere**: GOV.UK stamps `last reviewed` / `review needed by` with automated staleness banners; quarterly audit is the most-cited cadence. **No tool found does content-vs-code drift detection** — verifying ADR claims against source is genuine whitespace, and it is exactly what agent fan-out is good at.
5. **Agent-facing emerging practice** (2026, early signal): `applies_to`/`affects` file-glob field scoping which ADRs govern which paths (enables PR-time surfacing, scoped context loading, and drift checking); imperative MUST/MUST-NOT phrasing; a read-only MCP exposing `get_decision_context(files)` and `list_superseded` ("the graveyard") so agents don't re-propose rejected approaches; contradictions must be resolved before reaching agent context because models pick arbitrarily.
6. **Lint beyond schema**: adrkit's `adr lint` detects supersession cycles and silent contradictions; adr-tools automates the status flip + bidirectional link at supersede time (`adr new -s`).

---

## 3. Diagnosis

The problem is not "too many ADRs." Archived history is nearly free — 228 uncited accepted ADRs cost nothing until someone reads one. The problem is that **status metadata is untrustworthy**: ~39% of accepted ADRs no longer accurately describe the system, and an agent following a citation cannot tell which kind it holds. Every stale `accepted` is a small standing lie to every agent session that reads it; every unmarked reversal invites re-litigation or, worse, "fixing" code back toward a dead decision.

Three missing mechanisms, all cheap:

1. **No re-audit loop for accepted ADRs** (the root cause).
2. **No `amends` relation**, forcing partial supersessions into either a false `superseded` (260713-143958, 45 stale citations) or nothing at all.
3. **No citation hygiene**: nothing flags source comments pointing at superseded ADRs.

---

## 4. Recommended handling

### Move 1 — one-time reconciliation sweep (orchestrated)

Verify all 332 accepted ADRs and make every status true. Division of labor: scripts for everything deterministic, Sonnet for per-ADR verification, adversarial verify on non-current verdicts only, frontier model only for adjudicating contested verdicts and reviewing the final diff.

- **Phase 0 (scripts, free):** extend `adr-drift-check.mjs` into a staleness scanner — dead-path detection, supersession chain integrity (status⇄link consistency, cycles), citation counts per ADR, body-vs-manifest mismatch. Emits a scored worklist JSON. Fix the mechanical breaks outright (0027 → supersededBy: 0029).
- **Phase 1 (Sonnet fan-out, ~28 agents × 12 ADRs):** each agent verifies its batch against source and returns verdict + evidence + candidate `affects` globs + successor candidates, as structured output. (The 36-ADR pilot in §1 validated this design: ~120k tokens and ~5 min per 12-ADR batch, evidence quality high.)
- **Phase 2 (adversarial verify):** only non-CURRENT verdicts (~120 expected) get an independent refuter agent; disagreements escalate.
- **Phase 3 (adjudicate + apply):** frontier model adjudicates contested verdicts only. A script applies the outcome: status flips in manifest + frontmatter, one-line dated amendment notes in Status sections (bodies otherwise untouched), `lastVerified` stamps for every ADR examined. Obsolete-without-successor ADRs get flipped to `deprecated` with a one-line "what actually happened"; genuinely replaced ones get `superseded` + link. Trivial uncited still-true ones can take the existing archive lane.
- **Phase 4 (citation cleanup):** script maps the 99 stale source citations to successors; a small agent pass rewrites the comments; reviewed as part of the PR.

Deliver as 2 PRs: (1) tooling + schema + mechanical fixes, (2) the sweep's status corrections + citation cleanup. Rough cost: ~4–5M agent tokens, nearly all Sonnet.

### Move 2 — schema upgrades (steal from industry)

- **`amends: <id>`** relation (new ADR side) — parent stays accepted, gains an amendment pointer. Formalizes the existing partial-supersession prose rule into machine-readable metadata. Then revisit the 260713-143958 "do not fix" carve-out: with an `amends` relation available, it can become `accepted` + amended-by, ending the 45-file citation lie. (Owner's call — it reverses an explicit rule in `writing-adrs`.)
- **`lastVerified: YYYY-MM-DD`** per manifest entry, stamped by every audit pass. Powers worklist selection and a session-hook nag, GOV.UK-style.
- **`affects: [globs]`** — optional, backfilled by sweep agents for the ~104 load-bearing ADRs, required going forward. Enables scoped agent context, PR-time "governing ADRs" surfacing, and future drift checks.

### Move 3 — ongoing loop (so rot never re-accumulates)

- **`/adr:audit`** (new command or an `audit` mode on `/adr:review`): script builds a worklist (oldest `lastVerified` + anything newly flagged by the staleness scanner), fans out Sonnet verifiers, applies outcomes. Quarterly cadence, or triggered by the session-maintenance hook one-liner ("N accepted ADRs unverified in 120+ days").
- **Supersession hygiene at write time:** `/adr:create` and `/adr:from-spec` gain a required "does this replace or amend an existing ADR?" search step; the drift-check script enforces status⇄link consistency and cycle-freedom permanently.
- **Citation hygiene:** the staleness scanner flags source citations of superseded/deprecated ADRs; surfaced through the same session hook.
- **Raise the extraction bar** for single-surface UI implementation details (make "project-wide impact" a mandatory criterion rather than one of four), cutting inflow of future micro-ADRs.
- **Keep the current-state layer where it is**: `contributing/` + `AGENTS.md` remain the living docs; ADRs stay append-only history beneath them. `docs:reconcile` already patrols the guide layer.

### Explicitly rejected

- **Deleting or mass-archiving old ADRs** — 1,600 references depend on stable ids; history is the point; uncited ADRs are nearly free.
- **Rewriting ADR bodies to match present reality** — violates the append-only consensus and destroys the "why did we do this" record; amendment notes + successor records carry the delta.
- **A new living "current architecture" document** — would duplicate `contributing/architecture.md` and rot the same way.

---

## Open questions for the owner

1. Flip 260713-143958 back to `accepted` + amended-by once `amends` exists? (Reverses an explicit `writing-adrs` rule; the data says the current label misleads 45 files.)
2. Full 332-ADR sweep in one shot, or load-bearing 104 first and the uncited 228 opportunistically?
3. Should `/adr:audit` run as a scheduled flow task or stay hook-nag + manual?
