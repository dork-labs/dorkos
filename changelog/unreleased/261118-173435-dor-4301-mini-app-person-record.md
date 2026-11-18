---
covers:
  - 'fix(extensions): mini app data is kept from agents, and a person’s actions are recorded by DorkOS (DOR-4301)'
---

### Fixed

- Agents can no longer change a mini app's saved data with their file tools or shell commands, at any permission level. They can still read it. Mini apps keep saving their data as before (DOR-4301)
- Mini apps can now ask DorkOS to record something you did while signed in, and check it later. DorkOS keeps that record itself, outside the mini app's data, so a mini app can tell a comment you wrote from one an agent wrote (DOR-4301)
