---
covers:
  - 'feat: keep-awake modes, timed sessions, the screen and battery rules (DOR-2920)'
---

### Added

- You can now keep your computer awake the whole time DorkOS runs, not only while agents work. You can also keep it awake for a while, up to a day, even with keep-awake off. It ends on its own.
- A new setting keeps the screen on too while DorkOS keeps the computer awake, on Mac and Windows.
- Two battery settings: keep the computer awake only while it's plugged in, or stop once the battery drops below a level you pick. DorkOS picks up again on its own when you plug back in.
- These have no place in Settings yet. For now you set them from the command line, as the Sleep and wake guide shows. The Sleep switch in Settings still turns keep-awake on and off.
