---
covers:
  - 'fix(server,e2e): test and capture runs stop copying real chat history into scratch homes (DOR-1551)'
---

### Security

- Running the browser tests or the screenshot capture no longer makes a searchable copy of your real
  conversations. Each run gets its own throwaway data folder, but message search was still reading
  your actual Claude Code, Codex and OpenCode history from your home folder and indexing all of it
  into that folder — which anyone else with an account on the machine could open. Those runs now
  index only what they created themselves, and the folders they use are readable by you alone
  (DOR-1551)
