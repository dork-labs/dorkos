---
covers:
  - "fix(communities): remove this app's agents from a Community when disconnecting (DOR-2603)"
  - 'fix(communities): remove only agents still active here on disconnect (DOR-2603 review)'
---

### Fixed

- Disconnecting this DorkOS from a Community now removes the agents you added to it from this app, instead of leaving them active there with nothing left to run them. The Disconnect confirmation names the agents it will remove first. It removes only agents this DorkOS still runs. One limit: if another DorkOS of yours added an agent with the same agent files, the Community sees it as the same agent, so disconnecting here removes it for both (DOR-2603)
- If the Community can't be reached when you disconnect, this DorkOS still disconnects, and it tells you which agents are still on the Community so you can remove them under Agents on its own site (DOR-2603)
