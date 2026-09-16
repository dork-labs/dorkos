---
covers:
  - 'fix(claude-code): a warm agent keeps its background helpers until it is genuinely quiet (DOR-2064)'
  - 'refactor(claude-code): the quiet predicate gets its own module, and slice 3a keeps its own seams (DOR-2064)'
---

### Fixed

- Your agent's background helpers are no longer stopped while they are still working. The app used to close an agent down as soon as no message of yours was in flight — after five quiet minutes, when another chat needed to start its own agent, or half an hour after your last message. Anything the helpers had not finished was thrown away, and the agent was told you had refused.
- This now covers every kind of background work an agent starts: helpers, monitors, and task types the app does not recognise yet.
- An agent that is only talking to itself between your messages no longer counts as unused.
- Background commands are the one exception. They never hold an agent open, and they still stop when it does.
- Nothing waits forever. After four hours of background work the app takes the agent back anyway, and if a helper finishes without ever reporting in, the app stops holding the agent open for it after 30 seconds (DOR-2064, DOR-2065)
