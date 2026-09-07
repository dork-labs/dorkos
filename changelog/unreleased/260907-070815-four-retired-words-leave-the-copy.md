---
covers:
  - 'fix(client,server,site): four retired words leave the copy, and a gate keeps them out (DOR-1814)'
  - "fix(relay,scripts): the doctor's own words join the sweep, and the two API doc generators agree (DOR-1814)"
---

### Changed

- One word for the outside world, in the last places that still used four. A Telegram or Slack hookup is a **connection** everywhere now — on the Connections page, in the warning you get before letting an agent act without asking, in the message Slack and Telegram send back when someone who is not an approver taps a button, in what `dorkos doctor` reports, and on the website, which used to call the same thing a "Slack Adapter". Nothing you have set up changes; only the words do.
