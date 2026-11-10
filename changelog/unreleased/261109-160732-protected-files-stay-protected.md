---
covers:
  - "fix(server): DorkOS's own protected files are refused by the canvas, attachments and agent launches (DOR-4060)"
  - 'fix(server): the canvas browser, folders inside the data folder and room reads follow the same rule (DOR-4060)'
  - "fix(server): an agent's fork with no folder runs in its own folder, and a refusal says to name one (DOR-4060)"
  - 'fix(server): a scheduled run never stands in the home folder or the data folder (DOR-4060)'
  - "refactor(server): session_start's early protected-folder check moves unchanged into its own file (DOR-4060)"
  - 'fix(server): a scheduled run with no agent runs in a fresh, private folder of its own (DOR-4060)'
---

### Fixed

- **DorkOS's own private files stay private.** These include its sign-in key, its settings and its saved secrets. The canvas, room attachments and new chats an agent starts now refuse them at every level, with nothing to approve.
- **An agent that forks a chat without naming a folder now works in its own folder.** A launch refused for its folder says to name one.
- **A scheduled run never runs in your home folder.** Schedules with no agent used to run in the server's folder, which could be your home folder. They now run in a safe folder of their own. Give a schedule an agent if it needs a project's files.
- **An approval card for reading a canvas document names the file it reads.**
