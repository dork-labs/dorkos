---
covers:
  - 'fix(marketplace): a new version of a mini app from GitHub waits for your OK (DOR-4895)'
  - "fix(marketplace): the update card's mini app line stays true and fits a big update (DOR-4895)"
---

### Security

- A new version of a mini app from a GitHub plugin now waits for your OK in Activity, even if you allowed an earlier version. Until you do, that mini app is paused. The same version in another project still runs without asking. The update card says this under each mini app.
