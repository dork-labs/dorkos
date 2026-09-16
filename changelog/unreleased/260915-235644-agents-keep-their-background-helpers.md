---
covers:
  - 'fix(claude-code): a warm agent keeps its background helpers until it is genuinely quiet (DOR-2064)'
---

### Fixed

- Stop shutting down an agent while its background helpers are still working. When an agent hands work to helpers, those helpers keep going after the agent has finished replying to you — but the app used to close the agent down as soon as no message of yours was in flight: after five quiet minutes, when another chat needed the slot, or half an hour after your last message. Everything the helpers had not finished was thrown away, and the agent was told you had refused. Now the app waits until the agent is genuinely finished: no helper still running, no task of a kind the app does not recognise, and no finished helper still waiting to report back. An agent that is only talking to itself between your messages is no longer counted as unused either. Background commands are the one exception — they never hold an agent open, and they stop with it, as before. Nothing waits forever: after four hours of background work the app takes the agent back anyway, and a helper that finishes but never reports in is given 30 seconds before your next message is sent through (DOR-2064, DOR-2065)
