---
covers:
  - 'fix(client): keep the community switcher reachable, announced and usable from a message box'
---

### Fixed

- **⌘⇧K** (Ctrl+Shift+K on Windows and Linux) now opens the context switcher while you are typing in a message box. Before, it did nothing there, which is where you usually are after opening a channel (DOR-2186).
- If a community cannot be opened when you pick it, you stay where you were and the app now tells you so, instead of quietly snapping back (DOR-2186).
- With many communities, or with the page zoomed to 200%, the switcher now scrolls. Before, its first rows on a phone, including the search box, or its last rows on a computer, could end up off screen with no way to reach them (DOR-2186).
- On a phone, screen readers now hear the switcher's action rows as a proper menu (DOR-2186).
