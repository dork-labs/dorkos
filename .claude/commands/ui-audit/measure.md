---
description: Measure the rendered page against the design review floors — a PR's change, a surface, or a playground page
argument-hint: '<url> [routes, comma-separated] | pr:<number>'
allowed-tools: Read, Write, Bash, Grep, Glob
category: workflow
---

# Measure the rendered page

**Target:** $ARGUMENTS

Read `.claude/skills/auditing-ui/SKILL.md` §3 ("Measure the rendered page") and §8 (design review
of one change), and `contributing/design-review.md`, then follow them. This command adds only what
is specific to one measured pass.

## Contract

1. **Look, don't touch.** The browser-leg rules in skill §3 bind here unchanged: your own port
   (never `:6242` or `:6241`, and never `:4242`, the operator's own app), a standalone script, no
   mutating clicks, and an explicit degrade when nothing is runnable.

2. **Resolve the target.** A URL plus routes is measured as given. `pr:<number>` means: read the
   PR's diff, name the routes and dev playground pages its changed components render on, and
   measure those. When the PR only carries screenshots, review those and list the viewports,
   themes and states it is missing; a missing phone capture is itself a finding (design-review
   §8.1).

3. **Run the script** with the full capture matrix (its defaults) into the session scratchpad,
   never into the repo:
   `node .agents/skills/auditing-ui/assets/measure/measure.mjs --url <url> --routes <routes> --out <scratchpad>/measure --modes base,contrast-more,forced-colors,reduced-motion --focus-walk 12`

4. **Confirm before filing.** Open `summary.md`, then the screenshot behind every Blocker and a
   sample of the rest. Trace each confirmed flag to the `file:line` that sets the value. Drop
   what the picture contradicts, and say why.

5. **Judge the unmeasured rules by eye** from the same screenshots: hierarchy, states, motion
   (the reduced-motion captures), copy and system fit (design-review §1, §5, §6, §9 and §10).

6. **Report** in the sign-off format at the end of `contributing/design-review.md`, Blockers
   first. Each item gives the issue, the rule (§), the measured value against its floor, the
   `file:line`, and the fix. State the capture matrix that ran and anything skipped. On a PR,
   post it in the PR thread only when asked to; otherwise return it. This command writes no code
   and files nothing.
