---
covers:
  - 'fix(e2e): repair the browser suite, and stop it piling up folders in your home directory'
---

### Fixed

- Running the browser tests no longer piles up folders in your home directory. They used to create one under `~/.dork-e2e-fixtures` for every agent they invented and never clear it up; one machine had collected 546. They now work inside the project's own scratch folder and sweep up after themselves. (A handful of fixed paths under `~/tmp` remain — always the same four, so they no longer accumulate.)
- The browser tests can now run against a throwaway data directory, which is what the instructions for running them always said to do. Before, doing that put the server into a restart loop and nothing could run.
- The browser tests no longer attach themselves to a DorkOS you already have running. On the default port that was your real cockpit, so the tests could create and delete rooms and agents in your own data.
