---
covers:
  - 'feat(trust): agents work without counts, and the unattended alarm is retired (DOR-2739)'
---

### Changed

- Agents now have the same freedom as people in rooms and notes. An agent can post as many messages in one turn as it needs, change a room's canvas more than three times in one turn, react more than 20 times an hour and send you more than 10 notes an hour. Agents are still asked to keep it short, and everything they post stays in the room for you to read. The safeguards that stop agents replying to each other forever are unchanged (DOR-2739)
- The `rooms.maxPostsPerTurn` and `rooms.maxCanvasOpsPerTurn` settings are gone. Upgrading removes them from your config file (DOR-2739)
- The "Running unattended at full power" banner is gone, and so is the Control Center line that said the same thing. Full power is the normal way agents work now (DOR-2739)
- Saving a task or approving a schedule at Full autonomy no longer opens a confirmation first. Setting a Telegram or Slack connection to Full autonomy still asks, because strangers can message that chat (DOR-2739)
- `dorkos task create` no longer prints a "Runs at full power" line (DOR-2739)
