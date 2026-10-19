---
covers:
  - 'fix(server): a queued message from another agent shows its words, not our model wrapper (DOR-3060)'
  - "fix(server): another agent's queued message is never reworded or handed back as your draft (DOR-3060)"
  - "fix(client): Stop and the arrow keys treat another agent's queued message as theirs, not yours (DOR-3060)"
---

### Fixed

- A message another agent queues in a busy chat now shows its own words in the queue, instead of the block of instructions DorkOS wraps it in for the agent. The agent still gets the full wrapper, which keeps it from mistaking another agent's words for yours.
- Message search shows those words too, for messages indexed from now on. To clean up older results, delete the search index and let DorkOS rebuild it.
- Another agent's queued message can be moved or removed but not edited, and Stop no longer puts it back in your message box as if you had written it. The Stop question now says which messages come back and which are cancelled, and the arrow keys skip over other agents' messages.
