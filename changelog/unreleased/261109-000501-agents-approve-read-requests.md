---
covers:
  - "feat(db): the access-change ledger records an agent's read approval and the request it answered"
  - "feat(connectors): an agent approves another agent's read request, and an agent's Undo is checked as what it does"
  - "fix(connectors): no agent reverses a person's access change, and the Activity line names who got Read"
---

### Added

- **An agent can approve another agent's request for Read on an app.** It can give only Read, and only on an app it holds itself, never more than it holds. It can't approve its own request, approve write access, or approve from a turn another agent started or one DorkOS marks as having read words it can't vouch for. DorkOS doesn't yet notice when a turn reads an email or web page through a connected app, so these limits don't cover that case. You see each approval in Activity and can undo it.
- **An agent can undo an access change, under the same rules.** Putting access back counts as approving it. Taking it away counts as narrowing it, so it needs a one-line reason and you hear about it in Needs you. Only you can let an agent back into an app it was left out of.
