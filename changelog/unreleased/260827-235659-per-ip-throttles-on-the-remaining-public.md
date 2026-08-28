---
covers:
  - 'feat(site): per-IP throttles on the remaining public API routes (DOR-1586)'
  - "test(site): pin every public route's throttle, its policy, and its bucket (DOR-1586)"
  - 'docs(site): the telemetry privacy contract says what the throttle reads (DOR-1586)'
  - 'fix(site,docs): close the six review findings on the public route limits (DOR-1586)'
---

### Changed

- The rest of the public endpoints on dorkos.ai now turn away a flood coming
  from one place: sending feedback, checking on feedback you sent, the two
  links in our newsletter emails, and the three places DorkOS reports anonymous
  usage to. Everything works exactly as before. Someone hammering one of them is
  asked to wait a few minutes, and each endpoint is counted on its own, so a
  flood at one never blocks another. Unsubscribing and reporting usage get
  generous room on purpose, so a real person is never turned away (DOR-1586)
- One thing changed in what we do with your IP address when DorkOS reports
  anonymous usage: we now count how many requests come from it in the last few
  minutes, so nobody can flood those endpoints. That count lives in memory for a
  few minutes and then it is gone. Your address is still never saved, never
  written to a log, and never passed to anyone else (DOR-1586)
