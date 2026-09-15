---
covers:
  - 'feat(mesh): an identity-write observer at the agent registry seam (DOR-2052)'
  - 'feat(server): broadcast agents_changed and config_changed on /api/events (DOR-2052)'
  - 'feat(client): agent and settings changes land in every open window (DOR-2052)'
  - 'test(server): pin the agents_changed coverage claim and the config_changed payload (DOR-2052)'
  - 'feat(skills): the app updates on its own, so stop telling people to refresh (DOR-2052)'
---

### Fixed

- New agents show up in the sidebar right away, in every window. Registering, renaming or
  removing an agent used to leave the list showing the old set until you reloaded the page, so
  a project you registered from a terminal, from a second window, or by asking DorkBot simply
  was not there. The same goes for settings: rearrange your sidebar in one window and the other
  follows (DOR-2052)
- The Remove button on an agent now clears its row on the spot, instead of leaving it on screen
  for up to half a minute in the window you clicked it in (DOR-2052)
