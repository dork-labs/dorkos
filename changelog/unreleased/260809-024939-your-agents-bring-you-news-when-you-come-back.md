---
covers:
  - 'feat(config): the welcomeBack block — greeting caps a person owns (team-room-home 4.3)'
  - 'feat(rooms): your agents bring you news when you come back (team-room-home 4.4)'
---

### Added

- **Come back to a summary instead of a scroll.** After a few hours away, each
  agent that actually did something while you were gone leaves one line in #team
  saying what it worked on and when it last changed. Agents that did nothing new
  stay quiet, and at most three lines land however many agents qualify.
- The lines are read from your own sessions, so they say what happened and
  nothing more. No agent is woken up to write one, so coming back costs you
  nothing, and work an agent already posted in the room is left out because you
  have read it.
- You decide whether this happens at all. The switch is in Settings →
  Preferences, and turning it off means no notes and no looking, not fewer notes.
  It is stored on your server, so it follows you to every device you open DorkOS
  on. Four hours is what counts as being away, and three is the most notes one
  return can produce; both are settings in your config file if you want different
  numbers: `dorkos config set welcomeBack.absenceThresholdMinutes 720`.
