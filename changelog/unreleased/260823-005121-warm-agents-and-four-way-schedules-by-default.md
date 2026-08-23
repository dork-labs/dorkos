---
covers:
  - "feat(shared,server): warm agents + 4-way schedules by default; unattended power resolves from the operator's stop (DOR-1432)"
---

### Changed

- **New setups keep their agents warm between messages.** A Claude Code chat holds its agent open instead of starting a new one for every message, so replies from your second message on come back about four times faster. Existing setups follow automatically in an upcoming update. This used to be an experiment you had to find and switch on; it is now simply how DorkOS works. The cost is memory — up to about a gigabyte per waiting agent, twelve at most, and an agent you have not used in five minutes shuts itself down. Nothing about what your agents may DO changes: the same program runs with the same permissions, and every action is checked exactly as before. **Two things worth knowing.** If you had deliberately turned this off, the update turns it back on — DorkOS cannot tell an off you chose from the off it shipped with, because the two look identical on disk. And while the setting waits for its switch in the app, the way to change it is `runtimes.claudeCode.persistentSession` in `~/.dork/config.json` (`dorkos config set` works too); a switch for it is coming.
- **Four scheduled runs at once, on new setups, instead of one.** A slow overnight task no longer holds up every schedule queued behind it. Existing setups follow automatically in an upcoming update, and the same caveat applies: if you had set it to one on purpose, the update raises it to four, because a one you chose and the one that shipped are the same number on disk. Anything from one to ten still works — it is `scheduler.maxConcurrentRuns`, in Settings under Tools.

### Added

- Scheduled tasks now start at **your** power level. Create a task without picking one and it runs at whatever you chose for new chats, worked out for the agent that will run it. If you never chose a level, nothing changes — a task starts where scheduled runs have always started, able to edit files and stopping for anything riskier. Picking a level on the task itself still wins, an agent still cannot choose one for you, and a task file on disk still cannot hand itself the never-ask level.
- `dorkos task create` now says so when the task it just made will run without ever stopping to ask, so a schedule armed from your default power level is never a surprise.
