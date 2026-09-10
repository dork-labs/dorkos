---
type: fixed
covers:
  - 'fix(build): bound local Turbo cache retention (DOR-1980)'
---

Keep local build caches under 10 GB and remove entries older than seven days. DorkOS also skips temporary Next.js cache files that do not belong in restored builds.
