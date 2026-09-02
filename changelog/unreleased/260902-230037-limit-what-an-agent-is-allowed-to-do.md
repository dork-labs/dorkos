---
covers:
  - 'feat(shared,server,client,cli): let a person cap what an agent may ever do (DOR-486)'
  - 'fix(server,shared,client): a revoked agent can no longer out-reach a capped one (DOR-486)'
---

### Added

- You can now cap what an agent is ever allowed to do. Pick its limit in the agent's Tools settings, or run `dorkos agent update --path <dir> --ceiling <observe|act|destructive>`: `observe` reads only, `act` changes things but never deletes them, and `destructive` is no extra limit. Anything past the line is refused, and no approval unlocks it — so this is how you get an agent that reads your repos and can never uninstall anything. Every agent starts with no extra limit, so nothing you already run changes until you set one. An agent can tighten its own limit; only you can loosen it. This covers what an agent asks DorkOS to do — one that can run terminal commands can still act outside DorkOS, and turning on Require login (Settings, under Security) closes that door too (DOR-486)
