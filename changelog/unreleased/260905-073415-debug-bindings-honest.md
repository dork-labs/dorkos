---
covers:
  - 'fix(server): the debug bindings probe tells the same truth as the doctor (DOR-1780)'
---

### Fixed

- The diagnostic view of a room's agents no longer contradicts the health check about the same agent. It used to look for a saved conversation anywhere on disk and report "found it", while the health check warned that the agent could not actually reach it — so anyone chasing a room that had forgotten everything was told to look somewhere else. Both now read the same answer, the "anywhere on disk" one is still shown beside it under a name that says what it is, and when the two differ the response says why (DOR-1780)
- The diagnostic view of a single session now says whether the runtime it names is the one that session actually runs on, or just the one it would get. A room's first session had no recorded runtime, so the view printed a guess as if it were a fact (DOR-1780)
- One room member DorkOS cannot look up no longer costs you the whole report. A busy or damaged database used to take down the diagnostic view and cut short the startup check that repairs rooms — the two places you go when something is already wrong. Now it costs that one member's answer, which is marked as unreadable rather than passed off as healthy (DOR-1780)
