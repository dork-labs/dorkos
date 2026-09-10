---
covers:
  - 'feat(client,desktop): capture the app view in one click for feedback (DOR-1956)'
  - 'fix(client,desktop): keep focus through an app-view capture, and bound it (DOR-1956)'
---

### Added

- Capture the app in one click when you send feedback. The feedback dialog gets out of the way, takes the picture, and attaches it — so a bug report shows what you were looking at without you having to take a screenshot yourself. It captures only the app, never the rest of your screen. In the desktop app the picture comes from the window itself, so it is exactly what you see (DOR-1956)
