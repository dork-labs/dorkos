---
covers:
  - 'fix(connectors): run actions that offer an optional file when none is sent'
  - 'refactor(connectors): keep both changed files under the size ratchet'
---

### Fixed

- Agents can send email and save drafts through a connected Gmail account again when there is no attachment. Before, any action that could take a file was refused, even when no file was sent.
