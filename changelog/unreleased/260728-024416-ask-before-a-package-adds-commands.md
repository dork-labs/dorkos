---
covers:
  - 'fix(marketplace): ask before a package writes shell commands into your settings (DOR-522)'
---

### Security

- Ask before an installed package adds commands to your coding agent. Some marketplace packages ship hooks: commands your agent runs on its own, before or after it does things. Until now, installing one was enough to put those commands in place, with nothing shown and nothing to click. DorkOS now shows you the exact commands and waits for your answer. Say yes and they go in; say no and the rest of the package still works. Your answer is remembered per package and per project, and if a later version wants to run something different, DorkOS asks again (DOR-522).
- Keep a project-scoped agent package inside its own folder. An agent package installed into a project used to unpack straight into the project root, so it could drop files anywhere, including places DorkOS reads. It now lands in `.dork/agents/<name>/`, the same way plugins do (DOR-522).
