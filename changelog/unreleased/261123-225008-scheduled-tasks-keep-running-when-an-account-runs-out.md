---
covers:
  - "fix(tasks): a scheduled run whose account is out or signed out runs on another account, and moving an approved task's account keeps it approved (DOR-5097)"
  - "fix(tasks): an agent's account move off credits or on Careful waits for approval, Undo never restores a restricted account approved, and every task shows its account (DOR-5097)"
  - "fix(tasks): an account-only change the move rule declines always waits for approval, and only an identified agent's move stays live (DOR-5097)"
---

### Fixed

- A scheduled task used to stop for days when its Claude account hit its weekly limit or signed out. Now its next run starts on another signed-in account that has room, and the task's run history says which account it used and why. DorkOS never moves a run onto DorkOS credits, your main sign-in, or an account you kept out of automatic moves. Open a scheduled task to see which account it runs on, its own or its agent's. Turn on **This account only** there to keep it on that account: a run then stops with a plain sentence instead of moving (DOR-5097).
- When an agent moves an approved scheduled task to another account, the task no longer goes back to waiting for your approval. You get a notice with an Undo, and the move is in the audit log. It still waits for you if you chose the Careful setting, if the move is onto or off DorkOS credits, or onto your main sign-in or an account you kept out of automatic moves (DOR-5097).
