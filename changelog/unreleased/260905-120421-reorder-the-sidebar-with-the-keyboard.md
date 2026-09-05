---
covers:
  - 'fix(client): keyboard users can reach sidebar drag from the Tab order (DOR-1746)'
---

### Fixed

- You can now pick up and reorder sidebar items with just the keyboard. Tab into a section, arrow down to the row you want, press Space to lift it, arrow to where it should go, and press Space again to drop it. Escape puts it back. Before this, the sidebar told screen readers a row could be dragged with the keyboard, but there was no key that could actually start the drag (DOR-1746).
- Enter still opens whatever a sidebar row points at — Space is the key that picks it up.
