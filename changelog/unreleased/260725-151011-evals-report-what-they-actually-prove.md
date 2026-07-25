### Fixed

- Our safety tests now say plainly how much they checked. The summary used to print the word "quarantined" next to a test and "0 failed" at the bottom, even when six of seven checks had failed. Each test now shows its real result, and the last line says how many tests could actually fail the run (DOR-449)
- A test run that could not fail, because every test in it was parked, used to finish green. It now fails and explains why, so an empty pass cannot be mistaken for a real one (DOR-449)
- Safety tests looked for tool names that never appear in a real session, so a test could report "the agent never tried it" when the agent tried and DorkOS correctly stopped it. They now match the names sessions really use (DOR-449)
- Clearing the spend limit on a manual test run used to remove the limit instead of using the default, and then throw away the report afterwards. An empty or nonsense limit is now rejected before anything is spent (DOR-449)
- The container tests now say which kind of isolation each test really ran in, so nobody has to guess whether a risky test ran in a container or on the machine itself (DOR-449)
- Test scratch folders and containers no longer pile up: parked tests stop keeping theirs, Ctrl-C cleans up, and `pnpm evals:sweep` clears anything left over (DOR-449)
