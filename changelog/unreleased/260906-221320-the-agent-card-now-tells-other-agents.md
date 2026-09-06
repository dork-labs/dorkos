---
covers:
  - 'fix(server,a2a-gateway): the agent card now tells other agents that calls need a key (DOR-1824)'
---

### Fixed

- The agent card an outside tool reads before talking to your agents now says that a key is needed. It only said so when you had turned login on or set a server key, so on a normal setup the card promised the call would go through and the call came back refused. Calls have always needed a key; now the card admits it. Reading the card still needs nothing while login is off, and the card never says where your key is kept (DOR-1824)
