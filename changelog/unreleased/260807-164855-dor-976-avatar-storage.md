---
covers:
  - 'feat(identity): store profile photos locally behind a sync-ready seam (DOR-976)'
---

### Added

- A profile photo can now be stored, and it stays on your own machine — under your DorkOS data folder, not in anyone's cloud. PNG, JPEG and WebP up to 2 MB; DorkOS checks what a file really is rather than trusting its name, and turns away anything else. Once stored, the photo shows up under the same name everywhere on the roster and in your account, so the two can't disagree. **There is still no page for choosing one** — this is the storage underneath, reachable only through the API for now; the Settings screen that asks for a photo is next. (DOR-976)
