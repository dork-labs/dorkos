### Added

- Agents now have to ask before removing an installed package. Every DorkOS action an
  agent can run through the capability catalog carries a size: read only, ordinary
  change, or cannot be undone. Reading is free, ordinary changes go ahead and get
  logged, and the one action that cannot be undone stops and waits for you, with
  plain-words instructions for the agent on what to do next. The check runs on every
  path an agent can reach: the API, the tools inside a session, and the tools an
  outside app like Claude Code or Cursor uses. Tools that are not in the catalog,
  such as deleting a scheduled task, are not covered yet (DOR-448).
- Your approval card now names the agent that asked and how consequential the
  action is, so you can tell who wants what before you answer (DOR-448).
- The activity feed now records what an agent tried and was not allowed to do, not
  only what it did (DOR-448).
- `dorkos call` takes an `--approval <token>` option, so an agent working from the
  command line can finish the same ask-and-retry flow (DOR-448).

### Changed

- A long request on an approval card is trimmed to two lines, so the Allow and
  "Don't allow" buttons stay where you expect them (DOR-448).
- If DorkOS cannot check what is waiting for your approval, the dashboard says so
  and offers to try again. Before, a failed check looked exactly like having nothing
  to answer, which could leave an agent waiting on you with nothing on screen
  (DOR-448).
- Uninstalling a marketplace package now asks you once, not twice (DOR-448).

### Security

- Agent identity tokens now expire. A token stops working after a week of not being
  used, and after a month no matter what. Before, a token handed out for a
  five-minute session last month still worked today, which mattered much more now
  that DorkOS records who an agent is (DOR-448).
- An approval covers one exact action, and the check happens before anything runs.
  An agent that changes even one detail of what it asked for has to ask again
  (DOR-448).
- Hiding does not help. An agent that leaves its name off a request still cannot run a
  catalog action that cannot be undone without your approval, and the card tells you
  plainly that DorkOS does not know who asked (DOR-448).
- When an agent presents an identity DorkOS does not accept, that now shows up in
  the debug log so you can see an agent with an expired or rejected token still
  trying. The token itself is never written down (DOR-448).
