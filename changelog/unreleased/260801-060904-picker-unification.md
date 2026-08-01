---
covers:
  - 'refactor(client): the Trust Dial becomes a shared control, not a status-line one'
  - 'feat(client): an integration binding picks its trust level on the same dial'
  - 'feat(client): a scheduled task picks its trust level on the same dial'
  - 'fix(shared): a mode summary stops describing one runtime as if it were all of them'
---

### Changed

- Choosing what an agent may do looks the same everywhere now — and always tells the truth for the runtime it runs on. Integration bindings and scheduled tasks used to ask this question with their own hand-written lists; both now use the same three-stop dial as a chat session, with the same honest line underneath about what the stop means for that agent.
- The integration binding's list said "asks before running shell commands" for every agent, which is false for agents that cannot pause to ask, and offered **Plan** as a level of trust — which it is not. Both are gone.
- Turning on **Full autonomy** for an integration or a schedule now asks first, and says what stops happening on that surface: an integration gives up the Approve and Deny buttons that would have arrived in your chat, and a scheduled run gives up the approval it would have waited on.
- A schedule that still stops to ask now says so plainly: nobody is watching a scheduled run, so an action it pauses on waits there until the run hits its time limit.
- Install previews describe a package's schedule in words that hold for every agent, instead of describing Claude Code and hoping the reader is on it.

### Fixed

- An integration or a task saved at a setting the dial does not offer keeps that setting instead of being quietly widened to a broader one. It says which setting it is, and saving leaves it alone until you pick something else on purpose.
