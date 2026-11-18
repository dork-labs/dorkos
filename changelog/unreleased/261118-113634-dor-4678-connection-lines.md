---
covers:
  - 'fix(connections): agents are told when an action needs a one-by-one pick, and why their writes were lowered (DOR-4678)'
---

### Fixed

- When an agent looks for, or tries, an action that "Read and write" never covers, such as moving an email to the trash, it is now told that you give that action on its own, under exact actions on the Connections page (DOR-4678)
- An agent whose "Read and write" was moved to "Read" by the recent update is now told why, and that you can choose "Read and write" again on the Connections page (DOR-4678)
