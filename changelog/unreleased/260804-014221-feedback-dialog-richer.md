---
covers:
  - 'feat(feedback): message-first dialog with previewable diagnostics, conversation, and anonymous send (DOR-856)'
---

### Added

- Sending feedback from the cockpit is richer and clearer. The dialog leads with your
  message, shows who it will be sent as (with a one-click "Send anonymously" that really
  withholds your name and email), and tucks diagnostics and the recent conversation behind
  an "Attachments & details" panel. You can open a full preview to see exactly what will be
  sent before you press Send — nothing leaves your machine until you do, and home paths and
  secrets are removed first. Bug reports include the recent conversation and a scrubbed slice
  of server logs so the team can see what led to the problem.
- New ways to reach feedback: a "Send feedback" command in the command palette, a "Report"
  button on error toasts, and a "Report this crash" button on the crash screen — each opens
  the dialog ready to send.

### Changed

- The help menu now leads with "Send feedback" and "Report a bug", adds "Feedback &
  requests", and keeps the GitHub option available but tucked below. Reporting on GitHub is
  no longer in the command palette.
