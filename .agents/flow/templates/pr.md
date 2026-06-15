<!--
  /flow PR template — the VERIFY stage fills this and opens/updates the PR at
  the human-review gate (spec §13, §5). The review gate is ALWAYS ON: VERIFY
  attaches the ProofShot-style evidence bundle, opens the PR, transitions the
  work item to the review state, assigns the human, and stops.

  Fill the {placeholders}; drop a row that genuinely does not apply (and say
  why). The "Proof of completion" section is load-bearing — a PR without it is
  not review-ready. Tracker I/O (linking, assigning) flows through the
  linear-adapter, never a tracker string here.
-->

## Summary

{1–3 sentences: what changed and why. Describe the user-facing outcome, not just
the diff.}

## Linked work item

{The 1:1 tracker anchor for this change, by identifier — e.g. `Closes DOR-123`.
ID-only back-link; the filesystem (spec/ADR) holds the prose.}

## Test / validation summary

| Check               | Result                                                  |
| ------------------- | ------------------------------------------------------- |
| Unit / integration  | {e.g. `pnpm test` — N passing}                          |
| Typecheck           | {`pnpm typecheck` — clean}                              |
| Lint                | {`pnpm lint` — clean}                                   |
| Acceptance criteria | {each of the work item's `## Validation criteria`, met} |

## Proof of completion

> Per the `evidence` config (spec §13). Attach what an interactive/CLI VERIFY run
> can produce; if a class resolved to no capture, say so rather than faking proof.

- **UI / visual:** {link to the annotated GIF (`gif_creator`, interactive) or the
  `apps/e2e` WebM (`recordVideo`, unattended) for the touched surface}
- **Temporal / flow:** {link to the recording for any multi-step behavior}
- **Logic:** {test-pass summary / the relevant `__tests__` run}
- **Gaps:** {any evidence class that could not be captured, and why — never invent
  proof}

## Notes

{Assumptions logged during EXECUTE/VERIFY (the calibration trail, spec §5),
follow-ups, or anything the reviewer should weigh. The plan-approval gate is off
by default, so plan assumptions surface here at the review gate.}

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
