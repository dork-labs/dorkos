---
covers:
  - "fix(chat): another agent's queued message gets Send now and Don't deliver, waits on its own row, and never shows the wrapper (DOR-3060)"
  - 'fix(chat): Send now holds the row before it waits, never carries a passed-on mark, and a drain join folds in one transaction (DOR-3060)'
  - 'fix(chat): Send now never steers a row held to the default (DOR-3060)'
  - 'fix(chat): a quoted fence keeps its room or channel author, Send now waits for itself, and focus stays in the queue (DOR-3060)'
  - "test(server): the agent-computer write census refuses Send now, a person's decision (DOR-3060)"
  - "fix(chat): a failed Send now or Don't deliver stops waiting for its row to leave (DOR-3060)"
  - 'fix(chat): the queue strip says how many wait, not who sent them; long agent names wrap (DOR-3060)'
  - 'fix(chat): the queue''s "more below" fade shows, and re-measures when the window or a row resizes (DOR-3060)'
---

### Changed

- A message another agent sends to a busy chat now waits as its own row in the queue, with two buttons: **Send now** and **Don't deliver**. Send now adds it to what the agent is doing right away, or puts it first in line when that isn't safe. Don't deliver asks once, then takes it off the queue.
- When you don't deliver another agent's message, that agent's chat says so by name, for example "Dana removed it before it was delivered."
- Messages from other agents that wait together still go to the agent as one turn when it's free, so nothing arrives late.
- The queue above the message box says how many messages are waiting. A long queue scrolls, with a soft shade at the bottom when more messages are below. On a narrow phone screen, the note about when they send is hidden while another agent's message is waiting, so the count stays readable.

### Fixed

- An older message from another chat whose sender is no longer on record now shows its words under "Another chat", never the wrapper text the agent reads, and never as if you wrote it.
