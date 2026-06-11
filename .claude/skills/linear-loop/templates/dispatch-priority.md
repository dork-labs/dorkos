# Dispatch Priority — Selecting the Next Task

Ordered decision rules for picking what to work on next. `/pm` applies these during ASSESS/RECOMMEND when multiple items compete; the orchestration extension implements them as its dispatch sort. One policy, two consumers — change it here, not in code comments.

Derived from `research/20260611_work-sequencing-linear-method.md` (Little's Law, Linear Method, Reinertsen SJF, Shape Up, kanban classes of service).

## Inputs

Read from Linear — these must be maintained per SKILL.md conventions:

- **Priority**: native field (1=Urgent, 2=High, 3=Medium, 4=Low, 0=none). None sorts last — unprioritized work structurally cannot jump the queue.
- **Estimate**: native field, Fibonacci (1 ≈ single agent session; 5+ should have been decomposed).
- **Blockers**: Linear blocking relations only. Prose claims ("blocked by DOR-38") are not blockers — verify and convert them to relations when found.
- **Due date**: present only on genuinely fixed external dates.
- **Project status + completion ratio** (done issues / total issues).

## Decision Rules (highest precedence first)

1. **Expedite** — An Urgent (P1) issue preempts everything, ignores WIP caps. At most ONE expedite item in flight at a time. If two are Urgent, oldest first — and flag it: two simultaneous Urgents usually means priority inflation.
2. **Due-date slack** — For issues with due dates: `slack = due_date − today − expected_cycle_time` (use the estimate in sessions ≈ days until real cycle-time data exists). Slack ≤ 0 → treat as expedite.
3. **Project WIP cap: 2** — Count in-progress projects. At the cap, do NOT start issues from any other project. Pull the next issue from the in-progress project **closest to completion** (highest done/total ratio) — finish, don't fan out.
4. **Below the cap** — Open the highest-priority not-started project (project priority field, then oldest). Never cherry-pick single issues out of a project you haven't committed to: starting a project is a commitment decision, not a side effect.
5. **Within a project** — Sort ready issues by: priority ascending → **smallest estimate first** → oldest created first. (Smallest-first within a tier is Reinertsen's shortest-job-first special case. Estimate never overrides priority — that's deliberate; see the research doc for why full WSJF was rejected.)
6. **Blockers** — Skip any issue with a non-terminal blocker. A block older than 24h escalates to the human (it usually means mis-sequenced work, not a real dependency).
7. **Maintenance lane** — Reserve ~20% of capacity for the Maintenance project, worked in priority order. It is steady-state background, never ahead of committed project work — except via rules 1–2.
8. **Aging anti-starvation** — An unstarted issue older than ~2× its tier's expectation (High: 1wk, Medium: 2wk, Low: 4wk) is treated one tier higher. Note the promotion in the dashboard so the human can re-triage or archive.
9. **Circuit breaker** — A project in progress for more than ~2× its appetite (target date or summed estimates) stops receiving autonomous dispatch. Escalate: re-scope, re-commit, or cancel. Do not silently keep feeding it.

## Tie-breaking and edge cases

- All else equal: `identifier` ascending (stable, deterministic — matches Symphony §8.2).
- Issues in a state of type `triage` are never dispatchable — mechanical, not judgment. Linear Triage is enabled on the DorkOS team; acceptance (Triage → Backlog) happens upstream, and the orchestration extension's `active_states` must never include triage-type states.
- An issue with no priority AND no project is not dispatchable — route it to triage instead.
- `needs-input` issues are never dispatched; they're waiting on a human.
- `agent/claimed` issues are never dispatched; another worker owns them. If claimed with no evidence of progress for >24h, flag as stale claim.

## What this template does NOT decide

Whether work is _worth doing_ (triage), how _big_ it is (sizing at intake), or whether a hypothesis is _accepted_ (approval gate). Those happen upstream; by the time this policy runs, every candidate is already committed work.
