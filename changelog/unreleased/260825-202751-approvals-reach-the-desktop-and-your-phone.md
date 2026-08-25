---
covers:
  - 'feat(desktop,server): schedule and capability approvals reach the desktop banner and your phone (DOR-1570)'
---

### Added

- The desktop app now shows a notification when an agent proposes a scheduled task, or asks to do something it cannot undo — like deleting a schedule. Both used to show nothing at all on the desktop: the only sign was a quiet count on the bell, so you had to be looking at the right window to notice. Click the notification to open the thing you need to decide. (DOR-1570)
- When an agent asks to do something it cannot undo and nobody answers, DorkOS now reaches your phone after the same delay a proposed schedule uses — the "escalate to my phone after" setting under Notifications. Before this, that kind of request could sit for its full two hours with no signal outside the app. (DOR-1570)

### Changed

- An agent that proposes a schedule, or asks to delete one, is now told to say so in its reply instead of quietly stopping. It used to report the task as created and end the turn, leaving you to discover the approval on your own. In a DorkOS session it can also offer to open the Schedules panel for you. (DOR-1570)
