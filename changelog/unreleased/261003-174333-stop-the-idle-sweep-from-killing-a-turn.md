---
covers:
  - 'fix(server): stop the idle sweep from killing a turn that is still running'
  - 'fix(server): let a working helper keep its turn through a long quiet step'
---

### Fixed

- Long replies no longer get cut off at the 30-minute mark. DorkOS used to tidy away a session it thought was idle, even while the agent was still answering, and the reply ended with "Request interrupted".
- An agent that hands work to a helper now waits for the helper to finish, even when one step takes more than ten minutes, like a long build. Before, the reply was ended after ten quiet minutes and the helper's report never showed up.
