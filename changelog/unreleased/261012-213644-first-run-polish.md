---
covers:
  - "fix(server): a fresh install shows no 'while you were away' report (DOR-2845)"
  - 'fix(client): one Getting started list at a time (DOR-2845)'
  - 'fix(client): a new chat is named for its agent, never "Session" (DOR-2845)'
---

### Fixed

- A brand-new install no longer says "While you were away" a few seconds after setup. The daily summary now waits until there is something from an earlier day to report.
- On your first day, the sidebar shows one "Getting started" list instead of two. The card at the bottom waits until the list at the top is done.
- Your first chat with DorkBot is listed under DorkBot's name, not "Session". A chat with no known agent now says "Chat".
