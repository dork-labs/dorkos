---
covers:
  - 'fix(relay): a relay message into a chat follows the same place rule as starting one (DOR-5200)'
  - 'fix(relay): the place rule for a relay message reads every way it reaches a chat (DOR-5200)'
  - 'fix(relay): a message to an agent after its first relay turn still reaches it (DOR-5200)'
---

### Changed

- An agent's Relay message into a chat now follows the same rule as the chat API. It can still post into its own chat and message other agents, but a chat that is another agent's is refused (DOR-5200).
