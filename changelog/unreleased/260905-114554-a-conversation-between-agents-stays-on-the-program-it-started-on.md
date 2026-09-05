---
covers:
  - 'fix(server): relay conversations bind their runtime at first turn (DOR-1774)'
  - 'fix(server): only a turn that SPOKE binds its runtime (DOR-1774)'
---

### Fixed

- Editing an agent's setup while another agent is talking to it no longer switches which AI tool answers — the conversation stays with the tool that has its history. DorkOS used to re-read the agent's setup on every message, so a change made mid-chat handed the rest of the conversation to a tool that had never seen any of it and answered from nothing. Your change still applies everywhere else you use that agent — in rooms, in chat, and in new sessions you start; the one running agent-to-agent thread keeps the tool that has been answering it (DOR-1774)
- An agent-to-agent message that could not run at all — the AI tool not signed in, for example — no longer locks that conversation to the tool it happened to try. Fix the setup and send again, and the next message goes where you said (DOR-1774)
