---
covers:
  - 'fix(server): a value a newer build wrote under a setting this one has no longer wipes the config (DOR-1227)'
---

### Fixed

- Your settings no longer get wiped when a newer version of DorkOS saves a choice an older one has not learned yet — a new theme, a wider limit. The older version now just uses its own default for that one setting, keeps everything else exactly as you had it, and leaves your real choice in the file so the newer version still has it when you go back (DOR-1227)
- `dorkos config validate` no longer calls your settings broken when the only thing it found was a setting saved by a newer version (DOR-1227)
