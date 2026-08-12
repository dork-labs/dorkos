---
covers:
  - 'feat(client,obsidian-plugin): the Obsidian panel gets the cockpit sidebar (DOR-1080)'
---

### Changed

- **The DorkOS panel in Obsidian now looks like the app.** Its list of conversations is drawn
  with the same rows the cockpit sidebar uses: a coloured dot when a chat is working, waiting
  on you or has gone wrong, sentence-case group names instead of shouty capitals, and one "⋮"
  menu per row holding Rename, Fork and Details — so everything you could do by hovering is now
  also reachable from the keyboard. Arrow keys walk the list; Tab steps past it in one press
  instead of one per conversation. The dividing lines are gone, replaced by the same soft
  shading the app uses. The Obsidian plugin is still an early, lightly tested surface, and this
  has not yet been confirmed in a real vault (DOR-1080)
