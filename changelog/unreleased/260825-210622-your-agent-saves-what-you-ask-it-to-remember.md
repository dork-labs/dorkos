---
covers:
  - 'fix(server,evals): an agent saves what you ask it to remember, or says it did not (DOR-1564)'
---

### Fixed

- When you tell your agent a standing rule in a one-to-one chat — "we deploy on Tuesdays, never Fridays" — it now writes that down before the turn ends, so a later conversation in a channel knows it. Some models used to answer "got it" and save nothing, and the next conversation had no idea. (DOR-1564)
