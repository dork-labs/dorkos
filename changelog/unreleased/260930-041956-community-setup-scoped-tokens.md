---
covers:
  - 'fix(cli): let community setup use FLY_API_TOKEN, FLY_ACCESS_TOKEN and NEON_API_KEY (DOR-2602)'
---

### Fixed

- `dorkos community deploy` now uses a Fly or Neon token you export, instead of quietly using your saved sign-in. Before, setting `FLY_API_TOKEN`, `FLY_ACCESS_TOKEN` or `NEON_API_KEY` to a limited token changed nothing, so setup could create things with more access, or in another account, than you chose. Setup now hands those tokens to `fly` and `neonctl`, says in one line which ones it is using, and never writes them to its recovery notes or anything it prints (DOR-2602)
