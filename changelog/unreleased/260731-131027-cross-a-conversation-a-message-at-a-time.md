---
covers:
  - 'feat(chat): the session transcript is a WAI-ARIA feed, and the turn in flight is a live region'
---

### Improved

- Cross a session's conversation a message at a time with Page Down and Page Up. A long chat used to be one press per message and everything in it before you got anywhere; now the transcript is a feed, so one press moves to the next message however much it carries, and Ctrl+End jumps out to what is below it. Every message says who wrote it, when, and where it sits — "12 of 30, DorkBot" — so a screen reader reads a conversation instead of one long wall (DOR-779).
- An answer that is still being written is now read out as it arrives, sentence by sentence, instead of the whole answer being repeated on every word. When the turn finishes, only the last few words that were not yet spoken are — the message is never read from the top a second time.
- Waiting for a conversation to load is now announced rather than silent.
