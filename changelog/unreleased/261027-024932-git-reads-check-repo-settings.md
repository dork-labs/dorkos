---
covers:
  - 'fix(server): DorkOS reads git only through one runner that checks the repository first (DOR-3343)'
  - "fix(server): making or removing a workspace checks the source repo's settings first (DOR-3343)"
  - "fix(server): a folder's project lookup reads git's exit code, not its wording (DOR-3343)"
  - 'fix(server): a repository that names its own hooks folder can still be read (DOR-3343)'
  - "fix(server): the git audit reads a worktree's own settings only when git does (DOR-3343)"
  - 'fix(server): git status through the runner stays fast on a fresh checkout (DOR-3343)'
  - "fix(server): a Full chat's workspace is made past the git audit, with one Activity line (DOR-3343)"
  - "fix(server): a Full chat's workspace runs none of the repo's filter programs (DOR-3343)"
  - 'fix(server): Full overrides keep the agent.full_action Activity name (DOR-3343)'
  - "test(server): the session route's workspace mock carries fullChatOf (DOR-3343)"
  - 'ci(browser-test): the browser shards check out without a saved credential (DOR-3343)'
  - 'test(server): a plain folder agent home is in no project, stays eligible and starts its turn (DOR-3343)'
  - "fix(server): a folder's project lookup keeps a refused repository apart from no repository (DOR-3343)"
---

### Fixed

- When DorkOS reads a git repository for you, it now checks the repository's own settings first. If they ask git to run another program, DorkOS skips the read instead. The same check runs before DorkOS makes or removes a workspace from a repository. A chat set to Full autonomy is the exception: its workspace is made anyway, and the Activity page notes it. These reads never use the network or your saved git logins, and they don't use your own git settings. (DOR-3343)
