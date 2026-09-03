---
covers:
  - 'feat(shared,server,client): Stop says which of five endings it reached (DOR-1015)'
  - 'style(client): prettier on two test files (DOR-1015)'
  - 'merge: fold origin/main into feat/dor-1015-interrupt-receipts (DOR-1015)'
  - 'fix(server): drop an import the merge left unused (DOR-1015)'
  - 'test(server): DOR-1302's pump-stop tests speak the DOR-1015 receipt contract'
---

### Changed

- Pressing Stop now tells you what actually happened. Before, every ending looked the same: the agent hearing you and winding down, DorkOS killing the process because it never answered, the reply having already finished, and the agent refusing to stop all came back as the same yes or no. Now each one is its own answer, and the app only says an agent "stopped" when it really saw it stop. If the agent did not confirm, you get "Stop requested" and the Stop button stays there so you can press it again — instead of being told it worked while the agent keeps going (DOR-1015)
- Stopping a background task now answers with what happened rather than a plain yes or no, and it no longer reports "already stopped" for a task it could not confirm. Asking to stop a task that does not exist still answers the same error it always did; a task the agent would not confirm stopping now comes back as a normal answer that says so, because that task is probably still running (DOR-1015)
