---
covers:
  - 'feat(server): derived session titles get short and readable — courtesy words stripped, six-word budget (DOR-1055)'
---

### Improved

- Sessions that never got an auto-generated title now derive a cleaner one from
  your first message. Filler openers like "please can you" are dropped, the
  title caps at six words, and it gets a capital letter — so "please can you
  review the help and feedback submission options" shows up as "Review the
  help and feedback submission…" in the sidebar. Titles the assistant already
  generated are untouched.
