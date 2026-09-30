---
covers:
  - 'fix(cli): let community setup use FLY_API_TOKEN, FLY_ACCESS_TOKEN and NEON_API_KEY (DOR-2602)'
  - 'fix(cli): hand only non-empty credentials, and only to fly and neonctl (DOR-2602 review)'
  - 'fix(cli): name an exported credential on the removal path; update the launch fakes for provenance markers (DOR-2602)'
---

### Fixed

- `dorkos community deploy` now uses a Fly or Neon token you export, instead of quietly using your saved sign-in. Before, setting `FLY_API_TOKEN`, `FLY_ACCESS_TOKEN` or `NEON_API_KEY` to a limited token changed nothing, so setup could create things with more access, or in another account, than you chose. Setup now hands those tokens to `fly` and `neonctl` and to nothing else, says in one line which ones it is using (also when removing something a stopped setup left behind), ignores an empty variable, and never writes them to its recovery notes or anything it prints. Setup has not yet been tested end to end with a limited Fly token; signing in with `fly auth login` is still the tested path (DOR-2602)
