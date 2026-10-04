---
covers:
  - 'fix(client): let a link open the Inbox on the ask it names (DOR-2577)'
  - 'fix(client): solid ring on the linked ask, and list inbox as a dialog param (DOR-2577)'
  - 'fix(client): open for a link read before the bell mounts; respect where focus is (DOR-2577 review)'
  - 'fix(client): late ask takes focus unless typing; expire stale Inbox links (DOR-2577 re-review)'
  - 'fix(client): ask for nothing from a link read during onboarding; only text fields count as typing (DOR-2577)'
---

### Fixed

- A link can now open the Inbox right on the question it is about (DOR-2577). Before, Flow's "Review in Activity" link opened the Activity page, which lists past events but not open questions, so there was nothing there to answer. A link ending in `?inbox=` followed by the question's id now opens the Inbox over the page you are on, with that question highlighted and ready to answer. This works on a phone too. If the question was already answered, the Inbox still opens. Flow will use this in its next update.
