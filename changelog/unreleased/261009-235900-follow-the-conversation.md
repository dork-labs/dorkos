---
covers:
  - 'feat(rooms): a person in a channel is answered by the agent they are talking to (DOR-2823)'
  - 'fix(rooms): the default agent steps back for your conversation with another agent (DOR-2823)'
---

### Changed

- In a channel, a message you send without an @mention now goes to the agent you are talking to there: the one that answered you last, or the one you last @mentioned. Its own answers keep the conversation open, so a long answer no longer runs out the clock before you reply (DOR-2823)
- That conversation now lasts 60 minutes or 15 messages, up from 10 minutes or 5. If you set other numbers yourself, yours are kept. Agents talking to each other keep the old, shorter limit (DOR-2823)
- In #team, your default agent no longer answers alongside the agent you are already talking to (DOR-2823)
