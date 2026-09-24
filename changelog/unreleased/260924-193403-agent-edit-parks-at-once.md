---
covers:
  - "fix(tasks): park an agent's edit to an approved schedule in the same request, and keep the reason (DOR-2313)"
---

### Security

- When an agent changes what an approved schedule does, or when it runs, the schedule now stops in that same moment and waits for you. Before, it kept running on the agent's new version for up to a few minutes, until DorkOS noticed the changed file (DOR-2313)

### Fixed

- A schedule waiting for your approval keeps saying why. The note ("An agent changed what this schedule does", or "This schedule's file changed since it was last approved") used to be replaced a few minutes later by "DorkOS found this schedule in a file", which wasn't true (DOR-2313)
