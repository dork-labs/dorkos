---
covers:
  - 'feat(server,shared,db): an agent hears the answer it stopped waiting for (DOR-1931)'
---

### Fixed

- When your agent asks to do something that cannot be undone, it waits about ten minutes for you to say yes or no. You get two hours to answer. Answer after that ten minutes and, until now, nobody told the agent — you had to open its chat and pass the message on yourself. Now DorkOS tells it for you. Your answer arrives in the agent's own chat as a note DorkOS wrote and signed, so it always reads as a decision you made in the approvals panel and never as something you just typed. A "no" reaches it just as quickly as a "yes", along with the reason you gave, and it reads the same whether the agent is running on Claude Code, Codex or OpenCode. If the agent is busy, the answer waits its turn instead of getting lost; if its chat has ended for good, DorkOS says so in the log rather than failing. And you are only ever told once — an answer that reaches the agent while it is still waiting is not repeated afterwards (DOR-1931)
