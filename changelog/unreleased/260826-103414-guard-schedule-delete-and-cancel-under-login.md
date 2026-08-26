---
covers:
  - 'fix(tasks): guard schedule delete/cancel under login + document the local-trust posture (DOR-1574)'
---

### Security

- With Require login on, deleting a scheduled task or cancelling a run now needs a person signed in to DorkOS. A program holding one of your API keys is refused, the same as when it tries to change how a task runs. (DOR-1574)

### Docs

- The approvals guide now says plainly that if you leave agents running on their own and they can use a shell, you should turn on Require login. Without it, one of those agents can approve its own scheduled task. (DOR-1574)
