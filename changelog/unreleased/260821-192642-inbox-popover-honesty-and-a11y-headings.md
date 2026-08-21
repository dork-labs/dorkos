---
covers:
  - "fix(client): the Inbox popover speaks honestly about what's waiting, keeps its headings for phone screen readers, and eases the all-clear in (DOR-1395)"
  - 'fix(client): the Inbox popover keeps its "nothing runs until you decide" promise across every waiting state, not just one (DOR-1395)'
---

### Fixed

- The Inbox popover no longer calls a parked schedule a "request", or talks about it like a question. It now says schedule, request, or question, whichever is actually waiting on you (DOR-1395)
- On a phone, every section heading in the Inbox popover — Needs You, Scheduled Runs, Activity, Standing Permissions — is now read aloud by a screen reader. Before, they were dropped along with the rest of the desktop-only layout (DOR-1395)

### Changed

- Removed the extra sentence under "Scheduled Runs" in the Inbox popover. The summary above it already promises nothing runs until you decide, and the schedule card underneath already says what it's about to run (DOR-1395)
- The "All clear" checkmark now fades and rises into place instead of appearing all at once (DOR-1395)
