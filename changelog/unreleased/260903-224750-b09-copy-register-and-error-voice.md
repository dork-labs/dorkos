---
covers:
  - 'fix(client): settings speaks one voice, and the app stops shouting (DOR-1755)'
  - 'fix(client): errors say what happened and what to do next (DOR-1755)'
  - 'fix(client): no em dashes, no shell command with nowhere to type it (DOR-1755)'
  - 'fix(client): finish the adversarial review pass on the copy sweep (DOR-1755)'
  - 'fix(client): remote access speaks the same honest voice as the rest of the sweep (DOR-1755)'
---

### Changed

- Settings now sounds like one product. Rows that read like a manual ("Poll for updates to sessions running outside DorkOS", "Size in KB before a log file is rotated") now say what you get in plain words, and rows whose control already spoke for itself lost their filler description (DOR-1755)
- Every heading, button and menu item is sentence case now. "Reset All Data" is "Reset all data", "Open in New Tab" is "Open in a new tab", "Add to Chat" is "Add to chat", and the headings on Home stopped SHOUTING IN CAPS (DOR-1755)
- The messages that never reached an agent are no longer called "dead letters". That screen, and the Activity tab's, now say what happened in plain words instead of a raw wire code like `hop_limit`, whose messages they were, and what clearing them does, with the raw example folded away (DOR-1755)
- The Team page's grouping chip says "Group by owner" instead of "Group: manager", which is the word the rest of the page already used (DOR-1755)
- Settings describes each group of agent tools by what the agent gets to do ("Let agents send messages and check the inbox."), not a bare command fragment (DOR-1755)

### Fixed

- Errors tell you what to do next. "Failed to X" is now "Couldn't X", and the sentence written for you is the headline, with whatever the server said underneath it. You should no longer meet a bare "ENOENT: no such file or directory" with nothing else to read (DOR-1755)
- The setup screen no longer shows internal field names when it cannot save your progress. It says so in a sentence and keeps going (DOR-1755)
- A feature that is off now tells you where to type the command that turns it on, and offers to copy it (DOR-1755)
- On a phone, the empty Channels screen points at the All tab at the bottom instead of a sidebar that phones do not have (DOR-1755)
- A few error messages claimed something the app couldn't actually promise, like "Nothing was deleted" after a reset that failed partway through, or "Nothing you did was lost" on the screen for a crash so bad the app can't tell what happened. They now say what's actually true: it isn't sure (DOR-1755)
- Remote access said "Failed to start tunnel" and "Failed to stop tunnel" when it couldn't tell you why. Those now match the rest of the app's voice (DOR-1755)
