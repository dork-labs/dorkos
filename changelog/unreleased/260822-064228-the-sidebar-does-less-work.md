---
covers:
  - 'perf(client): the sidebar does less work when you pin, mute, or the clock ticks (DOR-1375)'
---

### Changed

- The sidebar redraws less. Muting a channel, filing one into a section, or the panel's own
  once-a-minute tick used to make every conversation row in the list redraw itself; now only the
  rows that actually changed do. Each row also waits until you reach for its menu before setting up
  what that menu can do, so a long list costs less just by being on screen (DOR-1375)
