---
covers:
  - "fix(tasks): a scheduled run whose account is out or signed out runs on another account, and moving an approved task's account keeps it approved (DOR-5097)"
---

### Fixed

- A scheduled task used to stop for days when its Claude account hit its weekly limit or signed out. Now its next run starts on another signed-in account that has room, and the task's run history says which account it used and why. DorkOS never moves a run onto DorkOS credits, your main sign-in, or an account you kept out of automatic moves. To keep a task on its own account, turn on **This account only** on the task: a run then stops with a plain sentence instead of moving (DOR-5097).
- When an agent moves an approved scheduled task to another account, the task no longer goes back to waiting for your approval. You get a notice with an Undo, and the move is in the audit log. A move to DorkOS credits, your main sign-in, or an account you kept out of automatic moves still waits for you (DOR-5097).
