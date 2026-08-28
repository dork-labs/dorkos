---
covers:
  - 'feat(site): per-IP throttles on the remaining public API routes (DOR-1586)'
  - "test(site): pin every public route's throttle, its policy, and its bucket (DOR-1586)"
---

### Changed

- The rest of the public endpoints on dorkos.ai now turn away a flood coming
  from one place: sending feedback, the two links in our newsletter emails, and
  the three places DorkOS reports anonymous usage to. Everything works exactly
  as before. Someone hammering one of them is asked to wait a few minutes, and
  each endpoint is counted on its own, so a flood at one never blocks another.
  Unsubscribing and reporting usage get generous room on purpose, so a real
  person is never turned away (DOR-1586)
