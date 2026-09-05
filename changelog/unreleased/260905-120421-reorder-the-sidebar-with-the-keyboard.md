---
covers:
  - 'fix(client): keyboard users can reach sidebar drag from the Tab order (DOR-1746)'
  - 'fix(client): Space picks up a sidebar section, Enter folds it (DOR-1746)'
---

### Fixed

- You can now pick up and reorder sidebar items with just the keyboard. Tab into a section, arrow down to the row you want, press Space to lift it, arrow to where it should go, and press Space again to drop it. Escape puts it back. Before this, the sidebar told screen readers a row could be dragged with the keyboard, but there was no key that could actually start the drag (DOR-1746).
- Enter still opens whatever a sidebar row points at — Space is the key that picks it up.
- The same works on a section you made yourself: Space picks the whole section up so you can move it, and Enter folds it. Sections that come with DorkOS — Channels, Direct messages, Agents — can't be moved, so Space still folds those.
- Lifting something and putting it straight back where it was no longer saves anything. It used to write your whole sidebar layout back to disk for a move that never happened.
