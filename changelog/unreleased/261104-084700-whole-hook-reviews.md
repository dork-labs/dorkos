---
covers:
  - 'feat(approvals): show whole hook disclosures and support individual re-asks'
  - 'feat(approvals): render full hook reviews and individual recovery'
  - 'fix(approvals): render hook values without JSON notation'
  - 'fix(approvals): preserve a declined hook refusal before re-asking'
  - 'fix(approvals): align whole hook review integration checks'
  - 'fix(approvals): retain denial audit rows during hook re-asks'
---

### Fixed

- Show complete hook commands and file fingerprints before approval.
- Keep unreadable hook requests from becoming lasting refusals.
- Keep the previous decline while its new hook review waits.
- Ask again about one declined package while keeping its previous decision.
- Show hook commands as written, with line breaks and hidden characters clearly marked.
- Keep a hook decline even when you ask again right away.
- Use the shared keyboard focus indicator on hook review titles.
