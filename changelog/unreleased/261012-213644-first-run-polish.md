---
covers:
  - "fix(server): a fresh install shows no 'while you were away' report (DOR-2845)"
  - 'fix(client): one Getting started list at a time (DOR-2845)'
  - 'fix(client): a new chat is named for its agent, never "Session" (DOR-2845)'
  - "fix(server): the first 'while you were away' report waits for an install-age gate (DOR-2845)"
  - 'fix(client): the name and role prompts ask while the Getting started card waits (DOR-2845)'
  - 'chore: one changelog fragment for the first-run polish (DOR-2845)'
  - 'chore: fold the review fixes into the first-run changelog fragment (DOR-2845)'
---

### Fixed

- A brand-new install no longer says "While you were away" a few seconds after setup. Your first daily summary arrives the morning after you set DorkOS up.
- On your first day, the sidebar shows one "Getting started" list instead of two. The card at the bottom waits until the list at the top is done, and the questions about your name and your work still get asked meanwhile.
- Your first chat with DorkBot is listed under DorkBot's name, not "Session". A chat with no known agent now says "Chat".
