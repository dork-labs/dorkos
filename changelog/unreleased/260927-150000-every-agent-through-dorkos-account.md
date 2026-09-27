---
covers:
  - 'feat(connectors): offer Every agent for apps connected through a DorkOS account (DOR-2439)'
---

### Added

- **Every agent** now works for apps you connect through your DorkOS account, not only apps you connect with your own key. Choose it in the app's **Who can use it?** card and every agent you have, including agents you add later, can use exactly the actions you picked. New or changed actions stay off until you review them, and **Stop sharing with every agent** takes access away on the next call, even while DorkOS Cloud can't be reached (DOR-2439).
- `@dork-labs/cloud-api` now says who a hosted connection grant covers: one agent, or every agent of the connection's owner (DOR-2439).
