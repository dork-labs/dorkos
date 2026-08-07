---
covers:
  - 'feat(client): sweep remaining identity surfaces onto kind, show agent owner (DOR-969)'
  - 'fix(client): stop the unresolved AgentChipPicker disc rendering invisible (DOR-969)'
  - 'fix(client): derive RequestingAgent kind from hasAgentPath, not requestedBy truthiness'
---

### Changed

- The chat message list and the hover card that opens over a name now share one rule for drawing agents and people, so an agent always looks like an agent everywhere you see it. (DOR-969)
- The agent picker in a room's add-agent dialog now draws every row as a filled square, the same shape agents get everywhere else, instead of a round dot. (DOR-969)
- The avatar next to an approval request now looks like an agent, too, whenever DorkOS can confirm one made the request. (DOR-969)
