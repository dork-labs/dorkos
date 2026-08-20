---
covers:
  - 'feat(server,shared,db,client): one notification system — history with read state, and one pipeline that decides what reaches you where (DOR-1383)'
---

### Added

- DorkOS now keeps a notification history with read state, and one pipeline decides what reaches
  you where. Finished runs, notes from your agents, messages that could not be delivered, agents
  that stopped answering, and version updates all land in one place you can come back to
  (DOR-1383)
- Questions your agents asked now leave a record of how they ended. An agent's question that
  nobody answered in four hours used to just disappear; now it is written down as "expired", so
  you can find out what you missed (DOR-1383)

### Changed

- Telegram and Slack messages about finished runs now ride the same system as everything else.
  What reaches your phone has not changed: a failed run always tells you, a successful one only
  if you switched that on for the integration. What is new is that the run is recorded either
  way, so a machine with no chat integration connected is no longer told nothing at all
  (DOR-1383)
- A note an agent sends you with "notify user" now also lands in your history, so a message you
  glanced at on your phone is still there tomorrow. The tool works exactly as before, including
  the limit on how many notes an agent can send you in an hour — and a note that hits that limit
  now leaves nothing behind at all, instead of quietly filling your history (DOR-1383)

### Security

- Requests for permission to run something are no longer broadcast to every connection. An agent
  connecting to DorkOS with its own token no longer sees what other agents are asking you for
  permission to do, which brings these in line with the questions agents ask you (DOR-1383)
