---
covers:
  - "feat(connectors): agents take connection access away, with a ledger and a person's Undo"
  - "feat(connectors): one access change for the person's Needs-you item, and the census entries for Undo"
---

### Added

- **Agents can give up access to an app they no longer need.** An agent can lower its own access to Read, remove some actions, remove all of it, or leave itself out of an app shared with every agent. Only a person can give access back.
- **An agent can take another agent's access to an app away, and you hear about it right away.** It has to say why in one line, and you see that reason in Needs you. It can't do this in a turn another agent's message started, in a turn DorkOS marks as having read words it can't vouch for, or more than 3 times an hour. DorkOS doesn't yet notice when a turn reads an email or web page through a connected app, so these limits don't cover that case. An agent left out of an app can't use it directly, but it could still ask another agent to.

### Fixed

- The review for removing an agent's access no longer says that agent keeps an app's every-agent share when it was left out of it.
