---
covers:
  - 'fix(desktop): satisfy the formatting and raw-NUL gates (prettier table, plist fixture escape)'
  - "fix(desktop): Restart to install actually installs — and never touches another app's updates (DOR-1455)"
---

### Fixed

- Clicking "Restart to install" now actually installs the update. DorkOS used to
  step in front of the installer's own restart — shutting itself down its own
  way and quitting — which left the installer with nothing to install, so the
  app came back on the old version every time. It now gets out of the way: it
  asks about any agents still working, stops its background server, and then
  hands the restart to the installer (DOR-1455)
- DorkOS clears out its own downloaded update once it has caught up with it. A
  copy left over from an earlier attempt used to be handed to the installer on
  every quit, for ever — and if you had installed a newer version yourself, that
  leftover could quietly put you back on the old one (DOR-1455)
- If an update cannot install itself, DorkOS now recovers instead of sitting
  there. Handing the restart to the installer means shutting down first, and on
  the rare occasions the installer gives up without saying so, DorkOS starts
  itself back up within a few seconds and tells you the update did not go in
  (DOR-1455)
- DorkOS notices when you install a new version while it is still running. It
  keeps running in the menu bar after you close its window, so dragging a new
  copy into your Applications folder used to change nothing: opening it just
  brought the old one back. Now it tells you the new version is there and offers
  to restart into it — and it makes sure a half-finished download from before
  cannot land on top of the copy you just installed (DOR-1455)
