---
covers:
  - 'feat(approvals): enforce standing permissions at the tier gate (DOR-501)'
---

### Added

- Standing permissions now work. When you answer an approval with "and stop asking about this", DorkOS remembers it for one agent doing one action, for as long as your trust window says, and lets that agent get on with it without interrupting you. Every time it does, your activity feed says so, and one line tells you which permission let it through. The buttons for all of this arrive with the next change; today it is the API and the enforcement behind it (DOR-501)

### Security

- A standing permission cannot outgrow what you agreed to. It covers one agent and one action, never a group of either. Its clock is set the moment you grant it and using it never extends the clock, so an agent cannot keep itself trusted by staying busy. It stops working the instant you end it, the instant you switch standing permissions off, and the instant you turn off Require login. And nothing an agent can do creates one: opening a permission needs a person signed in to DorkOS, so answering a single approval is not enough (DOR-501)
- Your agents cannot read the list of what they are allowed to do without being asked. Knowing which irreversible action goes through silently right now, and the minute the window shuts, is a map worth keeping to yourself, so that list needs the same proof of a person as answering an approval does. And when DorkOS starts, any permission left over from a time when it was not allowed to exist is ended, whether that is because standing permissions were switched off or because Require login was, so turning either back on never wakes an old one (DOR-501)
- No permission mode can switch off the questions about DorkOS itself. Running a session in a mode that skips prompts still leaves removing packages, deleting scheduled tasks, and the rest of the actions that cannot be undone behind the same question. That is now something DorkOS tests for rather than something that happens to be true (DOR-501)
