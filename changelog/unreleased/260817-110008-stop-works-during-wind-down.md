---
covers:
  - 'fix(server): Stop ends a turn that is winding down instead of waiting for a CLI that cannot hear it (DOR-1244)'
  - 'fix(server): a Stop that had to kill the CLI settles as interrupted, not as a reply that finished (DOR-1244 review round 1)'
---

### Fixed

- Stop now works while an agent is finishing up. Right at the end of a reply, an agent can wake itself back up — a background job it started reports in, or one of its own scripts runs — and DorkOS shows the reply as running again, with a Stop button on it. Pressing that button did nothing: DorkOS asked the agent to stop and then waited for an answer that could never arrive, so the reply kept going until the agent ended it on its own. Stop now gives up on asking politely after three seconds and ends the agent's work itself, and when DorkOS already knows the agent can't hear it, it ends the work straight away. The reply is then marked as one you stopped — not as finished, and not as an error. (One rough edge left: reopen that chat later and the reply reads as if it simply ended, because the agent never got the message that you stopped it.) (DOR-1244)
- Stopping a single background task is bounded the same way: if the agent doesn't answer within three seconds, DorkOS tells you it couldn't stop that task instead of leaving the request hanging — and it never ends the rest of the reply to do it (DOR-1244).
