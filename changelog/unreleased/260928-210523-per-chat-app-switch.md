---
covers:
  - 'feat(connections): turn an app on or off for one chat (DOR-2448)'
  - 'fix(connections): make the per-chat switch exactly reversible (DOR-2448)'
  - 'fix(connections): keep a chat limited for another agent limited (DOR-2448)'
---

### Added

- You can now turn an app on or off for one chat. Open the chat's details, and each app its agent was given has a switch. Turning an app off there only affects that chat. Turning it back on puts back the access that chat had, and never adds any (DOR-2448)
- When an agent asks for an app that its chat has turned off, the request card in the chat now offers to turn it back on for that chat and answers the agent in the same step (DOR-2448)
