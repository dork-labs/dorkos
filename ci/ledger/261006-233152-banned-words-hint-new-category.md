---
id: 261006-233152
title: Point the banned-words hint at the 2026-10 category phrase
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [2619]
ratchet-release: []
field-changes: []
---

The banned-words gate's failure hint named "one place" as the category phrase to use instead. DOR-2736 retired that line for "a workspace for people and agents", so the hint and the matching clean-prose sample in its self-test now name the new phrase, and a header comment is rewrapped.

Text only. The word list, the scan paths, the exit codes and the workflow step are unchanged, so nothing measurable should move. Revert if the gate or its self-test behaves differently on the same input.
