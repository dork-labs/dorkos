---
covers:
  - 'fix(server,db,client): scheduled runs are owned, counted, pruned, and never silently dropped (DOR-1482)'
  - 'fix(server): the task MCP tools keep the running cron jobs in step (DOR-1493)'
  - 'fix(server,client): retention never deletes a live run, and a skipped one says why (DOR-1482)'
---

### Fixed

- Starting a second copy of DorkOS no longer marks the tasks another copy is running as failed. Booting the cockpit while a dev server or the desktop app was mid-task used to end those runs in the record, throw away what they actually did, and send you a "task failed" notification for work that was going perfectly fine. Now only the copy in charge of the schedule ends a run, and only when it can show nobody is still working on it (DOR-1482)
- The limit on how many tasks run at once now counts every task, however it was started. With the message bus on, that limit counted nothing, so a slow task on a short schedule could pile up as many runs at once as the schedule allowed — and the "running now" count read zero the whole time (DOR-1482)
- An agent changing a task's schedule now changes when it actually runs. Editing a schedule through an agent used to update what the screen showed while the old schedule kept firing, and deleting one left it running against a task that no longer existed — in both cases until you restarted DorkOS (DOR-1493)
- A task that came round while DorkOS was starting up can no longer lose its turn without a trace: the record of a run and the note that its turn was taken are now written together, so a crash mid-way leaves the turn free for next time (DOR-1482)

### Added

- A task that could not run because DorkOS was already at its limit now says so in that task's history, at the time it was meant to run, instead of disappearing without a word. It shows as "Skipped", with the reason, and it does not count against the task's success record (DOR-1482)

### Changed

- Task run history is now trimmed every hour rather than only when DorkOS restarts, and the history is indexed for the way it is read. A task that runs every minute was adding about 43,000 rows a month to a server that stays up, and every one of them was scanned each time you opened the runs list (DOR-1482)

### Removed

- The "Timezone" setting under Tasks is gone. Every schedule already carries its own timezone, so this one never had any effect — changing it did nothing at all. Set the timezone on the schedule itself, as you always have (DOR-1482)
