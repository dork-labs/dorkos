---
covers:
  - 'feat(client,obsidian-plugin): the Obsidian panel gets the cockpit sidebar (DOR-1080)'
  - "refactor(client): the playground's session fixtures get a module, and the embed showcase a file (DOR-1080)"
  - 'fix(client,obsidian-plugin): the status dot gets a colour, and the scan gets a boundary (DOR-1080 review)'
---

### Changed

- **The DorkOS panel in Obsidian now looks like the app.** Its list of conversations is drawn
  with the same rows the cockpit sidebar uses: sentence-case group names instead of shouty
  capitals, a coloured dot when a chat is working, waiting on you or has gone wrong — hover it
  and it tells you which, in words — and one "⋮" menu per row holding Rename, Fork and Details,
  so everything you could reach by hovering is now also reachable from the keyboard. Arrow keys
  walk the list; Tab steps past it in one press instead of one per conversation. The dividing
  lines are gone, replaced by the same soft shading the app uses. Colours follow your Obsidian
  theme, so the rows highlight the way the file explorer beside them does. The Obsidian plugin
  is still an early, lightly tested surface, and none of this has been confirmed in a real
  vault yet (DOR-1080)
