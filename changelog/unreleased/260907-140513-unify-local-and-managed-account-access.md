---
covers:
  - 'refactor(connectors): share the verified Composio SDK adapter'
  - 'feat(connectors): add durable local connection resources'
  - 'feat(connectors): add managed Composio account client'
  - 'feat(connectors): simplify connection and agent access management'
  - 'feat(connectors): add managed local connection lifecycle'
  - 'fix(connectors): reflect managed authority synchronization'
  - 'feat(connectors): retire legacy management APIs'
  - 'feat(connectors): compose local and hosted connection authority'
  - 'feat(connections): unify local and managed account access'
---

### Added

- Connect several accounts for the same service, choose the exact actions each agent may use, and see the same access from the account or agent profile.
- Keep sign-in progress after a restart, review agent requests, and pause or disconnect accounts from Connections. See account usage without exposing action inputs.
- Use DorkOS-managed accounts or your own Composio account. Keep Slack and Telegram messaging separate from the actions agents may take through connected accounts.
