---
id: 261126-050459
title: The Codex permission rows' process helpers move to a fixture file
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Follow-up to 261125-214317. That change grew
`default-permissions.binary.test.ts` (run by `codex-binary-macos`) past its
max-lines entry (908 to 949). The process-tree helpers and pnpm finders move
unchanged to `__tests__/fixtures/process-tree.ts`; the file is 845 and its
entry drops to match. No behavior change: the pnpm row passes on a real
binary. Nothing to revert to.
