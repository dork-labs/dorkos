---
covers:
  - 'fix(server,client): a question nobody answered no longer reads "answered" after a reload (DOR-1293)'
---

### Fixed

- Reopening a chat used to put a green "Question answered" over a question nobody had answered. If
  you missed the question and the agent gave up waiting, the record of it said the opposite of what
  happened. Now the transcript says what actually became of it — nobody answered in time, you
  dismissed it, it failed, or no answer was ever recorded — and shows the agent's own words when
  there are any (DOR-1293)
- A tool you turned down, or left waiting until it timed out, no longer comes back looking like it
  ran. Reopening the chat shows that it was refused, and shows the reason the agent was given —
  including refusals that never went through DorkOS, like a tool you turned down in the `claude`
  command line or one your permission rules blocked (DOR-1293)
- A tool that simply failed now reads as failed in an old chat, instead of getting a checkmark
  (DOR-1293)
