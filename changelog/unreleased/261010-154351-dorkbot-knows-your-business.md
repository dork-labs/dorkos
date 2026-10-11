---
covers:
  - 'feat(onboarding): the first-run server API, Own AI presets and credits readiness (DOR-2783)'
  - 'fix(onboarding): serialize first-run picks and close the credits door on finish or dismiss (DOR-2783)'
  - 'fix(onboarding): keep a key whose model list cannot be read, and let a refusal be asked again (DOR-2783)'
---

### Changed

- DorkBot now knows what DorkOS is for. Its starter `AGENTS.md` talks about running your business with a team of agents and building mini apps, the tools your business runs on. If you never edited that file, DorkOS swaps in the new text the next time it starts (DOR-2783)
