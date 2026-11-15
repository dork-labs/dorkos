---
covers:
  - 'fix(tasks): the fails-twice notice says the real cause, the whole name and a 12-hour next try, and opens the schedule (DOR-4121)'
---

### Fixed

- When a schedule fails twice in a row, the notice now says why in plain words, such as "It ran out of time" or "Every agent slot was busy", instead of "An unknown error". The Needs you card shows the schedule's whole name, gives the next try in 12-hour time with the day when it isn't today, and its **Open schedule** button takes you to that schedule with its run history open.
