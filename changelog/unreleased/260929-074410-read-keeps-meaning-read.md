---
covers:
  - 'feat(connections): keep Read meaning Read as apps change their actions (DOR-2506)'
  - 'fix(connections): follow levels on their own, and never promise a refused level (DOR-2506)'
  - 'fix(connections): keep level follows small, and keep a level DorkOS was following when refused (DOR-2506)'
  - 'fix(connections): follow every level within 12 hours of its last follow, restarts included (DOR-2506)'
---

### Changed

- When you give an agent **Read** or **Read and write** on an app, DorkOS now keeps that choice as you made it. If the app adds a way to read, agents on **Read** get it. If an action starts changing things, or becomes high-risk, it leaves **Read**, and no high-risk action ever joins either level. DorkOS checks each app's actions every 12 hours while it runs, right after it's updated, and whenever you open **Who can use it?**, so while DorkOS runs, a change reaches your agents within 12 hours. It works the same for **Every agent** and for apps connected through your DorkOS account. Actions you picked one by one stay exactly as you picked them. An agent on **Read** no longer shows up as "Exact actions" just because the app changed (DOR-2506)
