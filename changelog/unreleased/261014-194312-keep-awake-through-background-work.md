---
covers:
  - 'fix: keep the computer awake through background work and retry a refused hold (DOR-2919)'
---

### Fixed

- Your computer now stays awake while an agent's background helper is still working, and while the agent writes up what the helper found. Before, it could fall asleep as soon as the agent said "I'll report back". Other background work, like a server left running, keeps it awake for at most 20 minutes.
- Your computer now stays awake for 3 minutes after the last piece of work ends, up from 30 seconds, so it no longer dozes off in the gap between one reply and the next.
- If your computer refuses to stay awake, DorkOS now tries again on its own, and switching the Sleep setting off and on tries again right away. Before, the switch was greyed out until you restarted DorkOS.
- The Sleep setting now says plainly that closing the lid usually still puts the computer to sleep, and that the screen still locks.
