---
covers:
  - 'feat(server): targeted sidebar-section capabilities for agents (DOR-2055)'
---

### Added

- Ask DorkBot to add an agent or a room to a sidebar section, and it changes only that section. It can create the section if you do not have one yet, and take things out again the same way. Until now the only way it could do this was to rewrite your whole sidebar at once, so a section you dragged at the same moment could be quietly undone (DOR-2055)
