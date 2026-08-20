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
  glanced at on your phone is still there tomorrow. The tool works the same way it always did:
  same answers, same limit on how many notes an agent can send you in an hour (DOR-1383)
- That hourly limit now actually holds. It counts every note an agent tries to send you, not
  only the ones that reached a chat app — before, on a machine with no Telegram or Slack
  connected, nothing ever counted and an agent stuck in a loop could talk to you forever. A note
  that hits the limit, or that you have switched off with "Agent can start conversations", now
  leaves nothing behind anywhere, instead of quietly filling your history (DOR-1383)

### Security

- Requests for permission to run something are no longer broadcast to every connection. An agent
  connecting to DorkOS with its own token no longer sees what other agents are asking you for
  permission to do, which brings these in line with the questions agents ask you (DOR-1383)
