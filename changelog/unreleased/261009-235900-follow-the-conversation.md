---
covers:
  - 'feat(rooms): a person in a channel is answered by the agent they are talking to (DOR-2823)'
  - 'fix(rooms): the default agent steps back for your conversation with another agent (DOR-2823)'
  - 'fix(rooms): the default agent steps back only for a partner that will answer (DOR-2823)'
  - 'fix(config): key the engaged-window migration 0.103.0 after main took 0.102.0 (DOR-2823)'
---

### Changed

- In a channel, a message you send without an @mention now goes to the agent you are talking to there: the one that answered you last, or the one you last @mentioned. Its own answers restart the clock, so a long answer no longer uses up the time before you reply (DOR-2823)
- That now lasts 60 minutes or 15 messages, up from 10 minutes or 5. If you set other numbers yourself, yours are kept. Agents talking to each other keep the old, shorter limit (DOR-2823)
- In #team, your default agent no longer answers alongside the agent you are already talking to (DOR-2823)
