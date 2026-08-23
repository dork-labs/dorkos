---
covers:
  - 'fix(server): an agent editing an approved task can no longer keep its no-approval power (security)'
---

### Security

- When you give a scheduled task permission to run without asking, an agent can no longer quietly change what that task does and keep the free pass. If an agent rewrites the task's instructions, its schedule, or its name, DorkOS puts the normal approval prompts back — so it can't turn a task you trusted into one you didn't. A task's name also can't hide extra instructions any more. Editing the task yourself still keeps the setting you chose.
