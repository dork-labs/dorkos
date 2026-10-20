---
covers:
  - 'fix(server): web approvals refuse folders that run code later, and commands that name protected folders'
  - 'fix(server): web approvals judge where a command runs, and refuse more places that run code later'
---

### Security

- Approving from the web now refuses changes to places that run code later, such as Git hooks, editor tasks, CI setup and your shell's startup files. Approve those at the computer.
- Approving a command from the web now refuses one that names an agent's settings folder, the DorkOS data folder or a place that runs code later, and one that runs inside a protected folder. Approve those at the computer.
