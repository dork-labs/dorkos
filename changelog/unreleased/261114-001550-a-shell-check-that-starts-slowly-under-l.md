---
covers:
  - 'fix(server): a shell check that starts slowly under load says retry, not restart DorkOS (DOR-4304)'
  - 'fix(server): refused shell commands are audited in the designer’s words, and one changelog entry covers the fix (DOR-4304)'
---

### Fixed

- When the computer is very busy, DorkOS's check on agents' shell commands can be slow to start. It still stops the command to be safe, but now it tells the agent to try the same command again in a few seconds, instead of asking a person to restart DorkOS. It also gives the check more time to start next time. (DOR-4304)
- The audit log now says why a shell command was refused. Before, every refusal was logged as a change to an agent's setup files, even when the check simply hadn't started. (DOR-4304)
