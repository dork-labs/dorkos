---
description: Capture a thought as a low-commitment work item (the /flow CAPTURE stage)
category: flow
allowed-tools: Read, Glob, Skill
argument-hint: '<idea or work description, or a file path>'
---

# /flow:capture — CAPTURE stage

Capture this into the tracker: $ARGUMENTS

Read `.agents/flow/skills/capturing-work/SKILL.md` and follow its process exactly.

That skill is PM-agnostic: it routes every tracker read or write through the
`linear-adapter` skill (`.agents/flow/skills/linear-adapter/SKILL.md`), which it
reads on demand. Do not touch a tracker directly from this command — the skill
owns the whole flow.

If no argument is provided, ask the operator for the thought to capture, then
follow the skill. CAPTURE only captures — it does not triage, evaluate, or plan.
For that, use `/flow:triage`.
