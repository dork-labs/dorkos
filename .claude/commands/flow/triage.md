---
description: Classify and route incoming work, simple-vs-complex (the /flow TRIAGE stage)
category: flow
allowed-tools: Read, Glob, Skill, AskUserQuestion
argument-hint: '<freeform brief/idea/bug, a file path, or an existing item identifier>'
---

# /flow:triage — TRIAGE stage

Triage this work: $ARGUMENTS

Read `.agents/flow/skills/triaging-work/SKILL.md` and follow its process exactly.

That skill is PM-agnostic: it routes every tracker read or write through the
`linear-adapter` skill (`.agents/flow/skills/linear-adapter/SKILL.md`), which it
reads on demand. Do not touch a tracker directly from this command — the skill
owns classification, evaluation, and the simple-vs-complex routing.

If no argument is provided, ask the operator for the work to triage (freeform
input or an item identifier), then follow the skill. TRIAGE classifies and routes
only — it does not run the autonomous loop, dispatch work, or audit the workspace.
