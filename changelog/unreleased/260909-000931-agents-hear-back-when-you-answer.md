---
covers:
  - 'feat(server): the requesting session hears back when you answer (DOR-1930)'
---

### Fixed

- When you approve or refuse an agent's request to remove an agent or delete a scheduled task, the agent now finds out on its own and carries straight on. Before, those two requests ended the agent's turn: you would approve the card, nothing would happen, and you had to go back to the agent and tell it yourself. Every other kind of request already worked this way; these two were the stragglers. If nobody answers within ten minutes, the agent falls back to the old behaviour and the card stays on your screen, so nothing is lost either way.
