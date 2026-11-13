---
covers:
  - "fix(canvas): opening a file outside the agent's folder on the canvas says so, instead of showing nothing (DOR-3519)"
  - "fix(canvas): only a room's canvas refuses a file from outside the agent's folder; your own window opens it as before (DOR-3519)"
  - "fix(canvas): a room's canvas also opens files from the agent's copy of that room's files and from the room's shared files (DOR-3519)"
---

### Fixed

- On a room's canvas, an agent that tries to show a file from outside its own folder and that room's own files now gets an error that names the file and says to copy it into its folder first. A room shares what its canvas shows with everyone in it, so it never shows them a file from somewhere else on your computer. Your own one-on-one window opens files just as before. (DOR-3519)
