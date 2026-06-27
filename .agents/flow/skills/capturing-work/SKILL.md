---
name: capturing-work
description: The /flow engine's CAPTURE stage — quick, low-commitment intake of a new piece of work into the tracker as an idea, without doing full triage or evaluation. Use when the goal is to get a thought captured cleanly so it survives, not to assess, classify deeply, or plan it. Generalizes the legacy /linear:idea capture flow (retired in spec #257); PM-agnostic.
---

# Capturing Work — the CAPTURE stage

> **What this is.** The first stage on the `/flow` spine
> (`CAPTURE → TRIAGE → IDEATE → …`, spec §1). CAPTURE turns a raw thought into a
> durable, low-commitment work item so it stops living in the operator's head and
> starts living in the tracker. It deliberately does **not** evaluate, classify
> beyond "this is an idea," prioritize, or plan — that is TRIAGE's job
> (`triaging-work`).
>
> **This is a prose contract, not code.** The agent reads this skill and follows
> it. A thin `/flow:capture` command and a PM-driven transition are two
> **triggers** for this one skill (spec §1).

## The one rule: never touch the tracker directly

This skill is **PM-agnostic**. It never names a tracker API, a tool string, or a
tracker-specific field. **Every tracker read or write goes through the
adapter skill** (the v1 `PMClient`, spec §3) by naming one of its
capability verbs — e.g. _"via the adapter, create the work item …"_. The
adapter owns all the tracker tooling and the projection of the generic
`WorkItem` shape onto the tracker; CAPTURE only speaks `WorkItem` + verbs.

Read the adapter skill's contract before acting.

## Process

1. **Take the input as the work description.** The trigger supplies it (the
   `/flow:capture` argument, or the PM transition's source item). If the input is
   a file path, read the file and use its contents as the description, noting the
   source path.
2. **Capture, don't evaluate.** If the input is too thin to make a meaningful
   item, ask for the **single** missing detail and stop — do not expand scope,
   classify deeply, or research. (CAPTURE is an intent stage: when genuinely
   unsure, lean toward asking — spec §5 stage bias.)
3. **Create the work item via the adapter.** Ask the adapter to create a
   new item with:
   - a concise, actionable, imperative-voice **title**;
   - the provided input as the **description** (include the source path if it came
     from a file);
   - **type** `idea` — CAPTURE always produces an idea; it is the lowest-commitment
     entry point and is re-classified later in TRIAGE;
   - **origin** `human` (the work originated from the operator);
   - the configured **team**, and a `backlog`-category intake state (the adapter
     projects this onto the tracker — the tracker's projection is the `type/idea` label
     and the **Triage** state; that mapping is the _adapter's_ concern, not this
     skill's).
   - Leave **priority** and **estimate/size** unset — commitment and sizing come
     at TRIAGE, not capture. No-priority sorts last in dispatch, which is correct
     for uncommitted work.
4. **Leave a provenance trail.** Via the adapter, post a structured
   next-steps comment so the item is self-documenting and TRIAGE knows where to
   pick up:

   ```
   **Agent Action** — [YYYY-MM-DD]
   **Action:** Captured idea, placed in intake
   **Reasoning:** Quick capture via the CAPTURE stage
   **Next steps:** Awaiting triage (the TRIAGE stage / triaging-work)
   ```

   The agent's own comments carry the adapter's identity marker so the
   comment-response rules (spec §5) never treat them as a human reply — the
   adapter applies that when it writes the comment.

5. **Report** the created item as identifier with title (`PROJ-157 - Title`, per
   the adapter's display convention), and that it is awaiting triage.

## Guardrails

- **Do not triage or evaluate here.** No alignment check, feasibility judgment,
  duplication search, prioritization, or planning. If the operator actually wants
  classification or routing, this is the wrong stage — use `triaging-work` (the
  TRIAGE stage).
- **Do not expand scope** beyond what the operator described. One thought in → one
  idea captured.
- **Reversible + confident → proceed silently** (spec §5 calibration ladder):
  capturing a single idea is cheap to undo, so don't over-ask. Ask only for the
  one missing detail that blocks creating a meaningful item.
- **If the tracker is unavailable**, the adapter will say so — surface that
  limitation plainly and stop. Never fabricate a capture.

## Stage handoff

CAPTURE's only successor is TRIAGE. A captured idea sits in the intake/backlog
state until `triaging-work` evaluates it (accept / reject / needs-research /
needs-refinement) and routes it onward. CAPTURE never skips ahead to IDEATE,
SPECIFY, or EXECUTE.
