---
covers:
  - "fix(server): a teammate's mark follows everything its turn sends, so one agent hop can't launder the tier or the spend limit (DOR-3036)"
---

### Fixed

- When a teammate in a shared space starts work, their limits now follow it all the way. If your agent mentions another agent, messages another chat, starts a new one, or picks the work up later on its own, that work stays limited the same way and counts toward the space's monthly limit. This holds after a restart too. It also stops once that limit is reached.
- A schedule an agent creates or changes after reading words from outside your team, or while doing work a teammate started, now waits for you to approve it, even on Trusted. The approval card says why and who started it.

### Changed

- A message an app sends to your agent is now treated like a message from outside your team: the agent asks you before anything risky.
