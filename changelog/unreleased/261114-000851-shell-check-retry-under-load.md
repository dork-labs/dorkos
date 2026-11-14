---
covers:
  - 'fix(server): when the shell check is slow to start, agents retry instead of being told to restart DorkOS (DOR-4304)'
---

### Fixed

- When the computer is very busy, DorkOS's check on agents' shell commands can be slow to start. It still stops the command to be safe, but now it tells the agent to try the same command again in a few seconds, instead of asking a person to restart DorkOS. It also gives the check more time to start next time. (DOR-4304)
- The activity log now says why a shell command was stopped. Before, every stop was logged as a change to an agent's setup files, even when the check simply hadn't started. (DOR-4304)
