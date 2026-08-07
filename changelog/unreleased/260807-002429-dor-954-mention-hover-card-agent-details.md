---
covers:
  - 'feat(client): show agent runtime and model in mention hover cards (DOR-954)'
---

### Added

- Hovering an agent's `@mention` in a room now tells you how that agent runs — the runtime it
  is on, and the model it starts on when it names one. Agents that just take their runtime's
  default model show the runtime alone, and an agent DorkOS has no details for shows nothing
  extra rather than a made-up answer (DOR-954).
