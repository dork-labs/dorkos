---
covers:
  - 'feat: Always allow on the request card replaces standing permissions'
  - 'feat: agents ask past Blocked with request_permission, and read their own permissions'
  - 'feat: unattended turns do not hold on an approval card'
  - 'feat(client): the request card has three answers, and shows in the room that asked'
  - 'test(e2e): the request card end to end, with docs'
---

### Added

- When an agent needs your yes, the card now has three answers: **Allow** (this once), **Always allow** (this agent, this action, from now on) and **Deny**. Always allow is saved as that agent's own permission, so you can see it and reset it on the agent's Permissions page.
- The card also shows up inside a room when that room's conversation caused it, so you can answer where the work is happening.
- An agent that is blocked from something can now ask you for it, and say why. You get a card with its reason. To keep this from turning into nagging, an agent can ask about one thing per area at a time, cannot ask again for a day after you say no, and can ask at most five times an hour.
- An agent can look up its own permissions, so it can tell you why something was refused instead of guessing.

### Changed

- Every answer you give on a card is recorded in your permission history, with who answered. With login off it says "Someone on this computer", because DorkOS cannot tell who pressed it.
- A scheduled run, a chat connection or another agent's message no longer holds its turn open for ten minutes waiting on a card nobody is watching. The card goes to your inbox, and when you answer, DorkOS tells the agent so it can carry on.

### Removed

- Standing permissions, the "stop asking about this for 8 hours" button, and the **Standing permissions** switches in Settings and the Control Center. Always allow replaces them. Any that were still running when you upgraded were ended, not made permanent, and your permission history has a line for each.
