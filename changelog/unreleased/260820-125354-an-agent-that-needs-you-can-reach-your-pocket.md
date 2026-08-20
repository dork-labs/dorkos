---
covers:
  - 'feat(server,client,shared,db): an agent that needs you can reach your pocket, and answering anywhere goes quiet everywhere (DOR-1387)'
  - "fix(server,client): a session's SECOND error escalates, and a removed schedule stops its clock (DOR-1387 review)"
---

### Added

- If an agent waits on you for more than a couple of minutes, DorkOS can now ping your phone's browser and your connected chat apps. Answer anywhere and everything else goes quiet. Set the delay, or turn it off, in Settings under Notifications.
- Settings under Notifications now lists the devices DorkOS can reach, with a button to add the one you are reading this on and a way to remove any of them. Adding your phone's browser is the point of it.
- Three things can reach you this way, and only three: an agent waiting for your answer, a scheduled task waiting for your approval, and a session that stopped on an error. News, like a turn finishing, never follows you around.

### Changed

- The setting that says how long something may wait before DorkOS tries another way of reaching you now does what it says. It used to be saved and ignored.
- A notification sent to your phone carries a short line and a link to the thing it is about, and nothing else. It never carries what an agent wrote or what it wanted to run, because your phone may show it on a locked screen.
