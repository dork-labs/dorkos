---
covers:
  - 'fix(ask): routine tool asks are calm and name the agent and the tool (DOR-4117)'
---

### Fixed

- The card that asks before an agent uses a tool is calmer. Its shield is gray, not red or amber, and its countdown turns red only for the last 30 seconds. The title now names who is asking and what, like "Atlas wants to use create_issue". When the name isn't known, it names the tool. (DOR-4117)
