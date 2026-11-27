---
covers:
  - 'feat(api): the owner’s connection lists come a page at a time; five move onto the capability mount (DOR-4982)'
  - 'fix(api): full-list reads stop on a repeated cursor; agents’ requests keep their oldest-first order (DOR-4982)'
  - "feat(api): the owner's connection lists come a page at a time; five move onto the capability mount (DOR-4982)"
  - "fix(api): full-list reads stop on a repeated cursor; agents' requests keep their oldest-first order (DOR-4982)"
---

### Changed

- Seven lists of connected accounts in the DorkOS API now come a page at a time, newest first: your connected accounts, what every agent gets, one agent's accounts, one chat's accounts, requested account changes, agents' requests for an app, and the agents left out of an account you share with every agent. The Connections page reads every page, so what you see there is unchanged.
- If you call these lists from your own scripts: each answer now carries `nextCursor`. Send it back as `cursor` to get the next page; it is empty (`null`) on the last one. `limit` sets the page size, 1 to 200, and is 50 when left out. A cursor from another list, or one DorkOS did not give, is refused with a clear message instead of starting over.
- Five of these lists (what every agent gets, one agent's accounts, one chat's accounts, requested account changes, and agents left out of a shared account) can also be read by their action name at `/api/capabilities/{id}/invoke`, only by you. Agents are still refused. In the API description they are now named `connectors.list_every_agent_grants`, `connectors.list_agent_connections`, `connectors.list_session_connections`, `connectors.list_reviews` and `connectors.list_exclusions`.
- The agents left out of a shared account are now listed newest first (they were oldest first).
- Agents' requests for an app still show oldest first in the app, so the one that has waited longest stays on top. Over the API the list now comes newest first, a page at a time; before, it had no set order.
