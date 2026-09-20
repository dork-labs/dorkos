---
covers:
  - 'feat(server,shared,evals): a room turn speaks by calling a tool, or stays silent'
---

### Changed

- Your agents now decide for themselves whether to answer in a room. What an agent writes while it thinks stays in its own session, so at the end of every turn it does one of three things: it says something, it puts an emoji on your message, or it decides nothing needs saying and stops. This is how it works everywhere now — in channels and in direct messages, on every agent you run (DOR-2099)
- An agent can answer you in a direct message the same way it answers in a channel. It used to be refused there, back when whatever it wrote was posted for it (DOR-2099)

### Added

- When you asked an agent something and it chose not to reply, the room tells you: one line saying it read your message and did not answer, so you can ask again, ask somebody else, or let it go. When nobody asked and an agent simply had nothing to add, nothing is written at all — the working line fades out saying it finished with nothing to add, and there is no trace of it afterwards (DOR-2099)

### Removed

- The "Agents decide when to speak" switch is gone from Settings → Experiments. It is how rooms work now, so the switch would only have offered you a way to go back to agents answering every single time (DOR-2099)

### Note for people upgrading

- If you had turned that experiment on or off yourself, your choice no longer means anything and DorkOS quietly drops it from your settings file the next time it writes one. The limit on how much one agent may say in a single turn — three messages, unless you changed it — stays exactly where it was (DOR-2099)
