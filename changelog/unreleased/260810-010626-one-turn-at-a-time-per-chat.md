---
covers:
  - 'fix(session): one turn at a time per chat (DOR-1088)'
  - 'fix(session): address adversarial review — alias-keyed serialization, a bounded wait, compact queues (DOR-1088)'
---

### Fixed

- **A chat now runs one turn at a time.** A message you had queued up could be
  sent while the agent was still working on the previous one, which started a
  second copy of the agent on the same conversation. The two wrote over each
  other, and the box you type in went quiet and unresponsive while replies were
  still coming in. A queued message now simply waits its turn and goes the moment
  the agent finishes.
- Stopping an agent works again in the cases where that second copy had taken
  over. When one of the two finished, it took the controls with it, so Stop had
  nothing left to talk to and the other kept running.
- The same protection now holds for a brand-new chat. A chat gets its permanent
  name a moment after it starts, and messages sent under the new name used to
  slip past the check entirely — which is exactly when it mattered, because that
  is your first reply in a new conversation.
- A chat whose agent crashed without a word no longer strands your next message.
  The wait has a ceiling: past it, your message gets the same answer anyone else
  would get, rather than queueing forever behind something that is never coming
  back.

### Changed

- `/compact` waits for the current reply to finish instead of interrupting it.
  Before, running it mid-reply quietly took the conversation out from under the
  agent that was still typing.
