---
covers:
  - 'fix(client): a paused connection says it waits on you, with a 44px Confirm (DOR-3288)'
  - "fix(client): a paused connection's row leads with its own label (DOR-3288)"
---

### Fixed

- A connection paused until you confirm a setting no longer says "Stopped working" on the Connections page. It says "Paused", then the connection's own name, so two paused webhooks are easy to tell apart, with a Review button. In Needs you, its Confirm button is now full width and easy to tap on a phone (DOR-3288)
