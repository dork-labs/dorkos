---
covers:
  - 'feat(api): adding or replacing an MCP server for every agent waits on a front-door confirm (DOR-4978)'
---

### Changed

- Adding or replacing an MCP server that every agent gets still asks you to confirm it's you, as before. The check now runs twice: when you ask, and again when you confirm. Both must come from you, on the computer DorkOS runs on or your own secure remote access, and you must confirm the same way you asked.
- The "Confirm it's you" sheet for adding or replacing a server now names only the server and the package it runs. It no longer shows the command, its settings, its headers or the server's web address.
- An agent or a program with a key that tries to add or replace one of these servers is now told only a person can do it. Before, it was told only the owner could.
- The activity log now records each hold and each confirm for these actions, and for paying for checks with DorkOS credits. Each record names the action and the check it needed, and never what you typed.
