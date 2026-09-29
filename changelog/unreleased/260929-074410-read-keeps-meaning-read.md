---
covers:
  - 'feat(connections): keep Read meaning Read as apps change their actions (DOR-2506)'
---

### Changed

- When you give an agent **Read** or **Read and write** on an app, DorkOS now keeps that choice as you made it. If the app adds a way to read, agents on **Read** get it. If an action starts changing or deleting things, it leaves **Read** straight away, and nothing that deletes ever joins either level. This happens each time DorkOS reads the app's actions, which it does when you open **Who can use it?** It works the same for **Every agent** and for apps connected through your DorkOS account. Actions you picked one by one stay exactly as you picked them. An agent on **Read** no longer shows up as "Exact actions" just because the app changed (DOR-2506)
