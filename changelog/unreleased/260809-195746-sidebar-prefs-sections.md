---
covers:
  - 'refactor(config): sidebar prefs move to a sections record, with a migration that loses nothing (DOR-1065, task 2.8)'
  - 'fix(config): an unknown sidebar section id is dropped on read, not refused (DOR-1065 review)'
---

### Changed

- The sidebar is being rebuilt, and the settings behind it moved house. Everything you had set
  comes with you: the sections you had folded shut stay folded, the way you had your agents
  sorted and filtered stays put, your pins, groups and muted conversations are untouched, and a
  tip you dismissed stays dismissed. There is nothing to do — it happens the first time DorkOS
  starts on the new version.
- Agents that read or change your settings can no longer see which sidebar sections are folded.
  Nothing sensitive was there; it is simply a shape the settings snapshot has no way to describe
  yet, and DorkOS leaves out anything it cannot describe precisely.
