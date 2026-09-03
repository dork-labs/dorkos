---
covers:
  - 'fix(client): composer queue actions grow to a real touch target below md (DOR-1753)'
  - 'fix(client): terminal and canvas tab strips grow their close button on mobile (DOR-1753)'
  - 'fix(client): background-task info stays reachable without a hover (DOR-1753)'
  - 'fix(client): schedule builder grows touch targets inside its mobile drawer (DOR-1753)'
  - 'fix(client): FilterBar primitives stop disabling touch scaling (DOR-1753)'
  - 'fix(client): raw height overrides stop rendering smaller on mobile than desktop (DOR-1753)'
  - 'fix(client): activity filter chips grow their tap target without growing the pill (DOR-1753)'
  - 'fix(client): mobile right-panel sheet sizes to content for the two tabs measured short (DOR-1753)'
  - 'fix(client): address adversarial review findings for touch-target audit batch 07 (DOR-1753)'
---

### Fixed

- Fixed several buttons on the phone that were too small to tap reliably — the queued-message actions in the composer, the terminal and canvas tab close buttons, the schedule builder's day-of-week picker, the activity page's filter chips, the Tasks/Team/Activity filter toolbar (Status, Filter, Sort, and the active-filters badge), and the background-task bar's expand arrow all now have a proper-sized tap area, even though the button you see stays the same size. (DOR-1753)
- Fixed the search box on Tasks, Team and other pages, which was quietly disabled from growing on a phone, and a few controls that had ended up smaller on a phone than on a full-size screen. (DOR-1753)
- What a background agent last did is now shown from a normal-sized screen up. On a phone, the task list keeps the agent's full description visible instead of shortening it to make room. (DOR-1753)
- The side panel on a phone no longer stretches to fill the whole screen when it has almost nothing to show — Pulse and the Files list now size to their own content instead of leaving most of the screen empty. (DOR-1753)
