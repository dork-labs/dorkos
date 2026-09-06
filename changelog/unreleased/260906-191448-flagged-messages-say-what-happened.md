---
covers:
  - 'fix(chat): a flagged message says so, and a reload no longer logs fake errors (DOR-1832)'
---

### Fixed

- When Claude's safety filter declines a message, the chat now says that plainly and tells you what to do: rephrase it, or pick a different model. Before, it only said "The request was rejected as invalid" and hid the reason under Details.
- Reloading the app used to print one red "query error" line per background check in the browser console. Those were the browser cancelling requests, not real failures, and they are no longer logged.
