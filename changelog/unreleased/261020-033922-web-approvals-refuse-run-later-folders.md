---
covers:
  - 'fix(server): web approvals refuse folders that run code later, and commands that name protected folders'
---

### Security

- Approving from the web now refuses changes to places that run code later, such as Git hooks, editor tasks, dev container setup and GitHub workflows. Approve those at the computer.
- Approving a command from the web now refuses one that names an agent's settings folder or the DorkOS data folder. Approve those at the computer.
