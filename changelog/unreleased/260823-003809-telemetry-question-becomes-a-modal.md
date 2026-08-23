---
covers:
  - 'feat(client): one-time moments rail; telemetry consent becomes a modal (DOR-1431)'
  - 'fix(client,docs): moments yield to a returning onboarding overlay; the consent surface is a dialog everywhere (DOR-1431)'
---

### Changed

- The telemetry question is now a one-time pop-up you answer and are done with, instead of a bar
  that sat across the top of the app until you got round to it. Nothing about the question or your
  answer changed — DorkOS still sends nothing unless you say yes, and "See what's sent" still shows
  the exact payload (DOR-1431)
- DorkOS asks you at most one of these one-time questions per launch, and never while first-time
  setup is still on screen. Anything else it wants to ask waits for a later launch (DOR-1431)
