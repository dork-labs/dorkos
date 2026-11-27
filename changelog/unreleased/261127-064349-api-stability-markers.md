---
covers:
  - 'feat(api): every operation says whether it is stable, preview or internal, and the published API document leaves the internal ones out (DOR-4983)'
---

### Changed

- Every operation in the DorkOS API document now says what it promises, in `x-stability`. **Stable** ones are meant for your scripts and tools. **Preview** ones are new or still changing, and may change in any release; their description starts with "Preview." The API's version is the DorkOS version.
- The app's own plumbing, such as sign-in steps, settings pages and the in-app browser, is no longer in the published API document or on the API reference pages. Those routes still work, but they can change at any time, so don't build on them.

### Removed

- **Breaking for scripts that used them:** `GET /api/relay/stream` and `GET /api/tunnel/stream` are gone. Read live Relay activity and the tunnel's status from `GET /api/events` instead (the `relay_message`, `relay_signal` and `tunnel_status` events). The DorkOS app already uses it.
