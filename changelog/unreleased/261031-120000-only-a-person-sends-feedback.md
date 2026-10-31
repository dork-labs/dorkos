---
covers:
  - 'fix(feedback): only a person can send a report, and a transcript is marked as untrusted (DOR-3506)'
---

### Security

- Agents can no longer send a feedback report themselves. Only a person can, so an agent can't attach a room's messages or a chat's transcript without someone choosing to send it. An agent can still hand you a report link to send. (DOR-3506)
- In a filed report, the attached conversation is now labelled as untrusted words, not instructions, so whoever triages it never acts on what other people in the room wrote. (DOR-3506)
