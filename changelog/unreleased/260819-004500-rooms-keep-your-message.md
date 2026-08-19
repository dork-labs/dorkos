---
covers:
  - "feat(client,server,shared): a busy agent's message waits and the room says so, instead of asking you to resend (DOR-1345)"
  - 'test(server,client): the hold path is pinned by a suite of its own, and an out-of-order answer says what it answers (DOR-1345)'
  - 'test(client,server): the waiting line, the peek rows and the promote route are pinned end to end (DOR-1345)'
  - "docs(server,client): the room's own docs, its conduct rule and the playground say what happens to a waiting message (DOR-1345)"
  - 'docs(e2e,specs): the browser walks the two-room wait, and the record says what shipped (DOR-1345)'
  - "fix(server,client): every waiting room is swept together, and the waiting line's peek says it is waiting (DOR-1345)"
  - 'fix(server,client,e2e): a wait ends when the agent leaves, the room says it gave up, and the ask lapses with it (DOR-1345)'
---

### Changed

- Rooms never ask you to send a message again. Your agent works in one folder at a time, so when
  you write to it in one conversation while it's busy in another, DorkOS keeps your message
  instead of turning it away. The line above the message box tells you what's happening:
  "Kai will pick this up when it finishes in #deploys". When that work ends, your message
  becomes the agent's next turn and the answer lands where you asked. Click the line to open the
  conversation that's in the way, or to ask for yours to be answered first. If your agent leaves the
  room, or you put the room away, DorkOS stops waiting and stops saying an answer is coming.
