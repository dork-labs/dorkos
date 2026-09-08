---
covers:
  - 'fix(server): a room agent starts at the power level you chose (DOR-1917)'
---

### Fixed

- Agents you talk to in a room now start at the power level you picked. If you set your power to Full autonomy, an agent you @-mention in a room used to ignore it and stop to ask permission instead. That is the one place nobody is watching, so the agent just waited. Now the room reads the same setting your other chats do, from the agent's very first reply. Rooms were the last place this setting did not reach: chats and scheduled tasks already followed it. If you have not set a power level, nothing changes. A room conversation that is already going keeps the settings it started with. And a message from someone in a linked Telegram or Slack chat still starts an agent at the careful setting, so a stranger cannot start one at full power (DOR-1917)
