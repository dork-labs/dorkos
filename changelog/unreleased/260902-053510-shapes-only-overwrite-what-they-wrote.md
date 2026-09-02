---
covers:
  - 'fix(server): a Shape owns only the schedules it wrote, by receipt (DOR-1524)'
---

### Fixed

- Copy one of a Shape's scheduled tasks to use as a starting point for your own, and it is yours to keep. DorkOS now remembers exactly which files it wrote when you applied a Shape, so removing that Shape removes only those — your copy stays, and re-applying the Shape never writes over it (DOR-1524)
- When an empty folder sits where one of a Shape's scheduled tasks would go, DorkOS says so on the apply screen and names the folder, instead of quietly skipping the task on every attempt (DOR-1524)
