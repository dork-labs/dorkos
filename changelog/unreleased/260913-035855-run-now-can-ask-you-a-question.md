---
covers:
  - 'fix(tasks): let a "Run now" ask reach the person instead of timing the run out'
  - "fix(client): show the server's reason when a message cannot be sent"
---

### Fixed

- "Run now" can ask you a question again. When you run a task by hand and the agent needs your
  go-ahead for something, the request now shows up where all your other requests do — the tray at
  the top, the Pulse panel, the home page — and you can answer it there. Say yes and the task
  carries on. Before this, the request went nowhere at all: nothing appeared, nobody could answer,
  and two minutes later the run gave up and blamed a schedule you had not used. A task the clock
  starts is unchanged — nobody is watching one of those, so it still gets on with what it can do
  without you and tells you afterwards what it had to skip.
- Every task run now opens to its own conversation. Click a run in a task's history and you land in
  the session it actually had, instead of an error.
- Stopping a task run also takes away the question it was waiting on. Before, the request sat in
  your list for hours pointing at a run that had already finished.
- The composer says why a message did not send. When the server turns a message down for a reason —
  "Choose a registered agent before starting this session", say — you now read that sentence
  instead of "HTTP 400".
