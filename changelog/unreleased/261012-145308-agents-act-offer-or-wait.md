---
covers:
  - 'feat(server): every agent follows the same rules for when to act and when to ask'
---

### Changed

- Every agent now follows the same rules for when to act and when to ask first. It does routine work and anything you asked for without checking in, and tells you what it did
- Before an agent sends something people outside your team will see, spends money or deletes things, it asks first unless you asked or it is its job. Promises to customers, signing up for things, spending past its limit and giving someone new access always need a yes from you or the agent's manager
- When an agent gets stuck on something only you can do, like a sign-in, it no longer just says it can't. It does every step it can, asks DorkOS for the access, suggests one way forward, and finishes once you choose
- These rules apply even when an agent's DorkOS knowledge setting is off, and in chats that are not tied to an agent
