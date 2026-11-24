---
id: 261124-153955
title: The pull request skill says "auto-merge on", not "armed"
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Hygiene: words only. No gate checks anything differently, and no number should move.

**What changed.** `.agents/skills/creating-pull-requests/SKILL.md` still called a pull request "armed" in a heading and one
sentence. Arming by hand was retired on 2026-11-23 (DOR-5124); a pull request opened with `scripts/open-pr.sh` has auto-merge
on and merges when its required checks are green. The heading and the sentence now say that. The same change brings fifteen
other skills and commands in line with `contributing/ci.md`; none of them is a pipeline path.

Revert if the skill's steps stop matching `scripts/open-pr.sh`.
