---
covers:
  - "fix(server): a schedule's timezone is part of what a person approves (DOR-2307)"
---

### Security

- If an agent changes only the timezone of a schedule you approved, the schedule now stops and waits for you to approve it again, the same as when an agent changes when it runs. The same time in another timezone can land up to a day earlier or later. Schedules you already approved stay approved, in the timezone they run in now, and a timezone change you make yourself keeps the schedule running (DOR-2307)
