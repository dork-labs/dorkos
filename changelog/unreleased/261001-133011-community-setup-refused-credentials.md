---
covers:
  - 'fix(community): report a refused create as missing permission, not uncertain (DOR-2656)'
  - "fix(community): say when an exported key can't read the organization (DOR-2657)"
  - 'fix(community): prove a refused Fly create made nothing, and wait out the create window before clearing (DOR-2656)'
  - "fix(community): require Fly's exact NOT_FOUND for a refused create, and say plainly when to clear (DOR-2656)"
---

### Fixed

- When Fly or Neon refuses to let your token create something during `dorkos community deploy`, setup now says so plainly: which service, which organization, and which token. Before, it called the outcome "uncertain" and offered a resume command that could never work. If nothing was made, it leaves no unfinished setup behind, so you can just run it again with a token that can. (DOR-2656)
- After `--remove-uncertain` finds that nothing was made, that setup no longer shows up in `--list-incomplete`. Right after a stop, it waits a few minutes first, in case the create is still finishing. (DOR-2656)
- When an exported `NEON_API_KEY` or `FLY_API_TOKEN` can't read the organization you chose, setup now tells you that, instead of asking you to check the service status and sign in again. For Fly, it also says the token may have expired. It never prints the key. (DOR-2657)
