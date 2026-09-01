---
covers:
  - 'fix(client,server,shared): one sign-in at a time, resolved from the session (DOR-1651 review)'
---

### Fixed

- Starting a sign-in from a chat no longer opens a second sign-in window if you scroll away and back, or if you have the same chat open in two tabs. One sign-in runs at a time, and every card shows you the same one
- Signing back in now picks the right account even when the very first message in a chat is the one that failed, which is the case an agent set up to use a second Claude account used to get wrong
