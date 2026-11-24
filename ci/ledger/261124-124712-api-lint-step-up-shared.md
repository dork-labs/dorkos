---
id: 261124-124712
title: The API lint counts the shared 428 "confirm first" answers as shared shapes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The `error-shape` rule in `scripts/api-lint/rules.ts` counted every 428 step-up answer as a
one-off, because the API document inlined the step-up body on each of the ~100 held writes. A new
held route therefore raised the count though it used the deliberate shared shape. The body is now
one named component, `StepUpRequired` (and the two passkey-checked device writes share
`PasskeyCheckRequired`), each 428 is a `$ref` to it, and both names join `SHARED_ERROR_SCHEMAS`.
An inline copy of the same shape still counts. The baseline only falls (error-shape 606 to 506);
no gate's retries, shards, timeout or required status change, so this is hygiene. Revert the list
entries if the named components ever stop matching what the server sends.
