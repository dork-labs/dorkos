---
covers:
  - 'fix(marketplace): ask before a package writes shell commands into your settings (DOR-522)'
  - 'fix(marketplace): bind hook approvals to when a command fires, not just what it runs (DOR-522)'
  - 'fix(marketplace): pin that a project-scoped agent install cannot eat the project (DOR-522)'
---

### Security

- Ask before an installed package adds commands to your coding agent. Some marketplace packages ship hooks: commands your agent runs on its own, before or after it does things. Until now, installing one was enough to put those commands in place, with nothing shown and nothing to click. DorkOS now shows you each command and when it would run, and waits for your answer. Say yes and they go in; say no and the rest of the package still works. Your answer is remembered per package and per project, and DorkOS asks again if a later version wants to run something different, or wants to run the same thing at a different moment (DOR-522).
- Stop an agent package from taking over the folder you install it into. Installing an agent package into a project treated the whole project folder as the package: DorkOS moved your folder aside, put the package in its place, and deleted the folder it had moved. It also meant the package could drop files anywhere, including places DorkOS reads. An agent package now installs into `.dork/agents/<name>/`, the same way plugins do, and everything already in your project stays where it is (DOR-522).
