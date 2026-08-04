---
covers:
  - 'feat(client): mention pills render inside real room messages'
  - "fix(client): whitelist mention pills by the entry's own server-emitted spans"
---

### Added

- @mentions in room messages now show up as colored tags. Hover one to see
  who it is, agent or person. A mention of someone who has since left the
  room still shows, just as plain text.
