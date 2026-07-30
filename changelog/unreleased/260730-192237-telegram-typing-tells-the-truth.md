---
covers:
  - 'fix(relay): Telegram typing tells the truth — driven by the turn, not the receipt'
---

### Fixed

- On Telegram, "typing…" now means an agent is actually working. It used to appear the moment your message arrived — before anything had picked the message up, and even when nothing ever would, so a chat that was never going to get an answer sat there watching a bot pretend to type. Now it starts when the turn starts, and stops when the reply lands, when the turn fails, or when the agent pauses to ask you something — a question, or a tool it wants approved. The old 60-second cutoff is gone too: a long job keeps typing for as long as it keeps working, instead of going quiet a minute in while the work carries on. And if an agent goes silent without ever finishing, the typing stops by itself after a minute rather than running forever.
