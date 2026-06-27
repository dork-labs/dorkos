---
name: triaging-work
description: The /flow engine's TRIAGE stage — classify and route incoming work. Classifies a freeform brief/idea/bug/question into the right work-item type, or evaluates an already-captured item (accept/reject/needs-research/needs-refinement) and routes it simple-vs-complex (stay-in-tracker task vs escalate to the spec workflow). Use when the goal is to evaluate and route work, not just capture it. Generalizes the legacy /pm triage/intake path; PM-agnostic.
---

# Triaging Work — the TRIAGE stage

> **What this is.** The second stage on the `/flow` spine
> (`CAPTURE → TRIAGE → IDEATE → …`, spec §1). TRIAGE is where raw work earns its
> shape: an incoming brief is **classified** into the right work-item type, and an
> already-captured item is **evaluated and routed** — accepted into the backlog,
> rejected, sent to research, or bounced back for refinement — and the
> **simple-vs-complex** decision is made (does this stay a tracker task, or
> escalate into the spec workflow?).
>
> **Scope.** This skill owns **only** triage/intake + complexity routing. The
> legacy `/pm` command bundled seven jobs (intake, triage, the autonomous loop,
> dispatch, audit, project-status management, the review dashboard); per spec
> §1/§10 those split apart — the **loop engine** (claim → carry to the review gate)
> is a later stage's concern, and a separate **audit** skill owns workspace-health
> checks. TRIAGE does not run the loop, dispatch work, or audit the workspace.
>
> **This is a prose contract, not code.** The agent reads this skill and follows
> it. A thin `/flow:triage` command and a PM-driven transition are two **triggers**
> for this one skill (spec §1).

## The one rule: never touch the tracker directly

This skill is **PM-agnostic**. It never names a tracker API, a tool string, or a
tracker-specific field. **Every tracker read or write goes through the
adapter skill** (the v1 `PMClient`, spec §3) by naming one of its
capability verbs — e.g. _"via the adapter, transition the item …"_. The
adapter owns all the tracker tooling and projects the generic `WorkItem`
shape onto the tracker (the type-label set; a `backlog`/`unstarted` state —
the tracker's Backlog/Todo); those mappings are the _adapter's_ concern, not this
skill's.

Read the adapter skill's contract before acting.

## Two entry shapes

TRIAGE handles two shapes of input. Decide which one applies first.

| Input                                                                                        | Path                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Freeform text / a file** that is not yet a work item (a brief, idea, bug, question)        | **A. Intake** — classify, then create |
| **An existing captured item** awaiting evaluation (e.g. an `idea` sitting in intake/backlog) | **B. Evaluate** — judge, then route   |

If the trigger names a specific item, take path B. Otherwise treat the input as
freeform and take path A.

## Path A — Intake (classify freeform input)

1. **Read the input.** If it is a file path, read the file and use its contents;
   note the source path.
2. **Classify into exactly one category** using this rubric:

   | Category              | Signals                                                                            | Result                                                                         |
   | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
   | **Idea**              | feature request, enhancement, "what if", "we should", suggestion                   | one `idea` item                                                                |
   | **Bug / Signal**      | error report, regression, metric anomaly, "broken", "failing", stack trace         | one `signal` item, **high** priority                                           |
   | **Research question** | "how does X work", "what's the best way to", "investigate", "compare"              | one `research` item                                                            |
   | **Feedback**          | references an existing item (by identifier), "regarding", "follow-up on", critique | find the related item and comment; create a `meta` item if it implies new work |
   | **Brief**             | multi-concern document, project-level scope, 3+ distinct deliverables/workstreams  | decompose into a project + several typed items (see below)                     |
   | **Ambiguous**         | cannot classify with confidence                                                    | ask the operator to clarify (TRIAGE is an intent stage — ask)                  |

   **Default to Idea** when no strong signal matches — it is the lowest-commitment
   entry point and is cheap to re-classify.

3. **Create the item(s) via the adapter** with: a concise imperative
   **title**; the full input as the **description** (include the source path if
   from a file); the chosen **type**; **origin** `human`; and **priority/size**
   set only when scope is already clear (a signal is high priority; ideas stay
   unset until commitment). If the description claims a dependency on another item,
   ask the adapter to create the typed **blocking relation** — dispatch reads the
   relation graph, never prose blocker claims. **Then ready the work for dispatch:**
   under the full-autonomy posture (decisions A0/A1) an accepted intake item is
   readied broadly, so via the adapter apply the durable `agent/ready` label
   - the successor `stage/*` label (a clearly-actionable item → `stage/execute`;
     work that still needs shaping → `stage/ideate`), exactly as Path B's Accept
     routing does (step 4 there). The only intake that stays unreadied is an
     `Ambiguous` input parked for clarification or a deliberately low-commitment
     `idea` held back for later Path B evaluation; a `Brief` is readied per route
     after its decomposition gate (next step) clears.
4. **Brief → project decomposition is a hard gate.** If the input is a brief (3+
   distinct concerns), this is a sticky, outward-shaping decision: **stop and
   present** the proposed decomposition (each concern → its type) and **ask for
   approval before creating a project** (spec §5 — sticky + project creation is a
   floor-level gate). Only on approval, via the adapter, create the project
   and the child items and link them.
5. **Leave a provenance trail and report** (see _Provenance_ below).

## Path B — Evaluate an existing item & route it

1. **Read the item fully** via the adapter (description, type, relations,
   project).
2. **Evaluate** across three quick checks:
   - **Alignment** — does it advance an active project's goals? (Pull projects via
     the adapter.) Note the project for assignment if it aligns.
   - **Feasibility** — is it feasible within the current architecture and known
     constraints? (Check `decisions/` if uncertain.) Estimate rough scope.
   - **Duplication** — search existing items via the adapter; if a near-duplicate
     exists, link it as related and note it.
3. **Decide and route** (drive the tracker side through the adapter):

   | Decision             | Criteria                                           | Routing                                                                                                                                       |
   | -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
   | **Accept**           | aligned, feasible, not a duplicate                 | transition to the backlog; assign to the aligned project; apply `agent/ready` + the `stage/*` label; then route simple-vs-complex (next step) |
   | **Reject**           | misaligned, infeasible, or out of scope            | transition to a `canceled`-category state; comment the reason                                                                                 |
   | **Needs research**   | feasibility or scope genuinely uncertain           | create a linked `research` item; keep the original in the backlog                                                                             |
   | **Needs refinement** | too vague to act on — the originator must say more | `needsInput`: post the question, apply the needs-input label, assign to the human, stop                                                       |

4. **On Accept, make the simple-vs-complex routing call** — the heart of TRIAGE.
   This call selects the **path**, never whether readiness is applied: under the
   full-autonomy posture (decisions A0/A1) every accepted item is readied for
   dispatch on both routes. Whichever route you take, **via the adapter,
   apply `agent/ready` + the `stage/*` label** so the dispatch eligibility gate
   (`@dorkos/flow` `AGENT_READY_LABEL`) can pick the work up; without `agent/ready`
   the item sits behind the gate and never dispatches (the keystone fix).
   - **Simple** (single-session, clear scope — roughly: single file / one
     clearly-scoped component, no new architectural pattern, no cross-cutting
     concern) → keep it **in the tracker** as a `task` (or a small set of `task`
     sub-items). It flows straight toward EXECUTE; via the adapter, apply
     `agent/ready` + `stage/execute` (the execute-adjacent stage label). It does
     **not** need the spec workflow.
   - **Complex** (3+ files across layers, introduces a new pattern, needs an
     architectural decision, cross-cutting, or multi-session) → **escalate to the
     spec workflow**: route onward to IDEATE (`ideating-features`) → SPECIFY; via
     the adapter, apply `agent/ready` + `stage/ideate`. The item becomes the
     spec's context and is linked for traceability; the spec carries the work from
     there.
   - **When in doubt, prefer complex** — over-planning is cheaper than
     under-planning.

5. **Set durable native fields.** While accepting, backfill a native **priority**
   and **estimate/size** if missing (these drive dispatch and the circuit
   breaker), and convert any prose blocker claims to typed relations — all via the
   adapter.
6. **Leave a provenance trail and report** (see _Provenance_ below).

## Provenance (both paths)

After any triage action, via the adapter post a structured next-steps
comment so the item stays self-documenting:

```
**Agent Action** — [YYYY-MM-DD]
**Action:** [e.g. "Triaged idea — accepted, moved to backlog" / "Classified intake as research"]
**Reasoning:** [brief rationale]
**Next steps:** [the routing decision — e.g. "Simple: convert to task" / "Complex: route to IDEATE"]
```

The agent's own comments carry the adapter's identity marker, so the
comment-response rules (spec §5) never mistake them for a human reply — the
adapter applies that on write. Then report to the operator: identifier(s) with
title (`PROJ-157 - Title`, per the adapter's display convention), type(s),
the accept/route decision, and what happens next.

## Guardrails & calibration

- **TRIAGE is an intent stage** (spec §5 stage bias): in the ambiguous middle
  (reversible but not confident), **lean toward asking** rather than guessing —
  classification and routing shape everything downstream. Use `needsInput` /
  `AskUserQuestion` per the inferred comms channel.
- **Floor gates always stop**, even at full confidence: creating a project,
  rejecting/cancelling someone's work, or any outward-facing change → present and
  ask first.
- **Stay in your lane.** TRIAGE classifies and routes; it does **not** run the
  autonomous loop, claim/dispatch work for execution, or audit the workspace —
  those are separate concerns (the loop engine and the audit skill).
- **If the tracker is unavailable**, the adapter will say so — surface the
  limitation plainly and stop. Never fabricate a triage outcome.

## Stage handoff

TRIAGE's successors depend on the routing decision: rejected items leave the loop;
accepted **simple** work is readied (`agent/ready` + `stage/execute`) and flows
toward EXECUTE as a tracker `task`; accepted **complex** work is readied
(`agent/ready` + `stage/ideate`) and escalates to IDEATE → SPECIFY (the spec
workflow); needs-research spins off a `research` item; needs-refinement parks on
the human until they reply.

Readiness (`agent/ready`) is the dispatch fuel TRIAGE produces: without it the
dispatch eligibility gate holds the item out regardless of its state category, so
the loop starves. TRIAGE is the first readiness producer; DECOMPOSE (see
`decomposing-work`) is the second, readying the execute-ready tasks it emits.
