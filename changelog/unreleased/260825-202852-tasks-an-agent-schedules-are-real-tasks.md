---
covers:
  - 'fix(server,operating-skills): scheduled-task tools write a real file, attach to an agent, and stop dropping fields (DOR-1568)'
---

### Fixed

- A task an agent schedules for you is now a real task. It used to make a task with no file behind it and no owner, so nothing kept it in step with your project and its runs happened in the wrong folder. The agent is now asked where the task belongs — under itself, or in your DorkOS folder — and the task is written there like any other. (DOR-1568)
- An agent that asks to schedule a task for an agent DorkOS has never heard of is now told so, instead of quietly making a task nobody owns. (DOR-1568)
- A time limit an agent sets when it schedules a task is now kept. The tool accepted the setting and then threw it away, so the task ran with no limit at all. (DOR-1568)
- Deleting a task through an agent now deletes it. Only the entry was removed, so the task came back on its own a few minutes later, after the agent had already said it was gone. (DOR-1568)
- Editing a task now refuses a field it cannot change, and says which one. Anything DorkOS did not recognise was thrown away and the edit reported as a success — which is how an agent came to believe it had filed a task under itself when nothing had happened. Where a task lives is decided when it is created; to move one, delete it and create it again. (DOR-1568)
