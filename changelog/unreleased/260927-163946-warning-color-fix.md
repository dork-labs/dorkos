---
covers:
  - 'fix(client): give warning colors a real token so they read as warnings (DOR-2444)'
  - 'fix(client): darken warning text further and move its guard into CI (DOR-2444)'
  - 'fix(client): scan for real comment trivia, not regex guesses (DOR-2444)'
  - 'fix(client): stop parsing, only skip whole-line comments (DOR-2444)'
---

### Fixed

- Warnings in agent creation and Connections (a name that's still missing, a schedule DorkOS couldn't check, access that needs another look) now actually render amber instead of ordinary text color — they used a color class the app's stylesheet never defined, so the styling was silently dropped (DOR-2444)
- Success checkmarks in Connections (a connection confirmed, an agent's access granted) now show green instead of ordinary text color, for the same reason (DOR-2444)
- Warning text got a bit darker app-wide, so it stays easy to read against every background it's shown on, not just the lightest ones (DOR-2444)
