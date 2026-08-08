---
covers:
  - 'feat(server): unaddressed #team posts reach your default agent (team-room-home 2.2)'
---

### Added

- Type in **#team** without naming anybody and your default agent answers. No `@` needed, and
  the rest of your team stays quiet instead of all piling on
- Name somebody with `@` and only they answer — and they stay the only one, including when
  they write back. Your default agent steps back rather than doubling up on a question you
  already handed to someone else, unless you named it too or you were already talking to it
- Setting an agent to "Everything" from a room's member list still means everything. Only the
  default agent's seat steps back, and changing your default agent never touches a choice you
  made yourself
- Pick a different default agent in Settings and the next thing you type in #team goes to the
  new one — no restart. The old one goes back to only answering when you address it
- If the agent named in Settings isn't on this machine any more, DorkBot picks up what you type
  instead of it going nowhere
