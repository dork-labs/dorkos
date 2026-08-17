---
covers:
  - 'fix(server,client): a question nobody answered no longer reads "answered" after a reload (DOR-1293)'
---

### Fixed

- Reopening a chat used to put a green "Question answered" over a question nobody had answered. If
  you missed the question and the agent gave up waiting, the record of it said the opposite of what
  happened. Now the transcript says what actually became of it — nobody answered in time, you
  dismissed it, or it failed — and shows the reason when there is one (DOR-1293)
- A tool you turned down, or left waiting until it timed out, no longer comes back looking like it
  ran. Reopening the chat shows the same "you denied this" or "expired" line you saw at the time,
  even when the decision was made outside DorkOS — in the `claude` command line, say (DOR-1293)
- A tool that simply failed now reads as failed in an old chat, instead of getting a checkmark
  (DOR-1293)
