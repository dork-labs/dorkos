---
covers:
  - 'fix(client): the schedules empty state starts at the top and scrolls (DOR-1748)'
  - 'fix(client): marketplace columns count the space they have, not the window (DOR-1748)'
  - 'fix(client): one readable tab always survives, and a tablet stops docking three panes (DOR-1748)'
  - 'fix(client): waking a sidebar row from focus stops flushing mid-render (DOR-1748)'
  - 'fix(client): a dialog stays a card at every width (DOR-1748)'
---

### Fixed

- On a phone, the top of the Schedules "No schedules yet" screen was cut off behind the header. It now starts at the top and scrolls (DOR-1748)
- Marketplace cards now measure the space they actually have instead of the width of your window, so opening a side panel no longer squeezes them into unreadable slivers (DOR-1748)
- On a tablet-sized window the side panel now slides over the page instead of squashing it, and the Home tabs never shrink away to nothing (DOR-1748)
- Pop-up windows now keep a margin from the screen edges, keep their rounded corners on a phone, and scroll when they are taller than the screen (DOR-1748)
- Removed the React warnings that appeared in the browser console every time the app loaded (DOR-1748)
