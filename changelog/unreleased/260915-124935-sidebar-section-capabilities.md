---
covers:
  - 'feat(server): targeted sidebar-section capabilities for agents (DOR-2055)'
  - 'feat(server): filing into a sidebar section moves the item, not copies it (DOR-2055)'
---

### Added

- Ask DorkBot to add an agent or a room to a sidebar section, and it changes only that section. If the thing was already filed somewhere else it moves, the way it does when you drag it yourself, and DorkBot tells you where it came from. It can make the section if you do not have one yet, and take things out again the same way. Until now the only way it could do any of this was to rewrite your whole sidebar at once, so a section you dragged at the same moment could be quietly undone (DOR-2055)
