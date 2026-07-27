---
covers:
  - 'feat(desktop): a stable address you can bookmark and point tools at (DOR-539)'
  - 'fix(desktop): honour a pinned port strictly, and stop the Server tab going blank (DOR-539)'
---

### Added

- See the address DorkOS is running on in Settings → Server, with a button to copy it and a button to open it in your browser. The MCP endpoint is right below it, ready to paste into Claude Code, Cursor, or Windsurf (DOR-539)

### Changed

- The desktop app now runs on `http://localhost:4242`, the same address as the command line, instead of a new random one every time you open it. Bookmarks and MCP setups keep working from one launch to the next. If something else already has that port, DorkOS takes the next free one and Settings shows you where it landed (DOR-539)
- You can pin the desktop app to a port of your own with `dorkos config set server.port 5000`, the same setting the command line reads. A port you pick this way is one DorkOS stays on: if it's taken, the app says so instead of quietly answering somewhere else and breaking whatever you pointed at it (DOR-539)
- Settings → Server now says when it can't reach the server, and offers to try again, instead of showing an empty panel (DOR-539)
