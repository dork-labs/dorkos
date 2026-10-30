---
covers:
  - 'fix(relay): a stranger on a linked chat can no longer open a file by naming it (DOR-2980)'
---

### Security

- On a Telegram or Slack chat linked straight to an agent, someone could write `@` and a file path, and the file's contents went to the agent before any check. Now that text stays plain words. It works as before only in a direct message from someone on that connection's approver list, so add yourself there if you use `@` from your own chat. The agent's level does not change.
