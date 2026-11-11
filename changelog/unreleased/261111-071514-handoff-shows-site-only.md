---
covers:
  - "fix(browser): while a person has the Agent browser, its status shows each tab's site only, with no title (DOR-4163)"
  - "fix(browser): a person's Pause and tab choice show the same trimmed tabs during a handoff (DOR-4163)"
---

### Fixed

- While you have the Agent browser after your agent hands it to you, DorkOS shows only each tab's site, such as `accounts.example.com`, and not the rest of its address or its title. A sign-in page's address or title can carry a one-time code, and both stay out of view until you hand the browser back. (DOR-4163)
