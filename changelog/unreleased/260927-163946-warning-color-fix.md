---
covers:
  - 'fix(client): give warning colors a real token so they read as warnings (DOR-2444)'
---

### Fixed

- Warnings in agent creation and Connections (a name that's still missing, a schedule DorkOS couldn't check, access that needs another look) now actually render amber instead of ordinary text color — they used a color class the app's stylesheet never defined, so the styling was silently dropped (DOR-2444)
