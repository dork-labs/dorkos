---
covers:
  - 'feat(relay,server,shared): every paid turn crosses one counted choke point (DOR-791)'
---

### Added

- There is now a ceiling on how many turns your agents can start by messaging each other. Every route into an agent — another agent, an outside system, a webhook answering back, a scheduled task running — is counted in the same place, so two agents told to keep each other posted stop after a while instead of talking all night. It ships at 1,000 turns an hour for any one agent and 5,000 across DorkOS, the same allowance rooms have. When it stops something, it says which limit it was and the message stays in the agent's inbox to be read later. A turn DorkOS accepted but couldn't run, because every slot was busy, doesn't count against you. Change either number with `dorkos config set relay.maxAgentTurnsPerAgentPerHour` / `relay.maxAgentTurnsTotalPerHour`, or set them to `null` for no limit at all — but note that `0` stops your scheduled tasks too, since they start turns the same way (DOR-791)

### Fixed

- A message that starts an agent's turn now sets the budget for whatever that agent sends next, instead of every reply starting over with a full one. That is what used to let two agents trade messages forever with a counter that never went down (DOR-791)
- A webhook pointed back at DorkOS runs down a real budget now. It already stopped after five laps; the number of turns it could buy and the hour it had to do it in were resetting on every lap (DOR-791)
