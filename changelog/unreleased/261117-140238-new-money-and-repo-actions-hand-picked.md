---
covers:
  - 'fix(connections): new money apps, OAuth actions and repository merges, tags and releases stay one-by-one picks by name (DOR-4505, DOR-4506, DOR-4509)'
  - "fix(connections): Bitbucket's branch and merge are pinned picks, and the name backstops cover more real shapes (DOR-4505, DOR-4509)"
  - "fix(connections): a stacked copy of a money app, like square_mcp_v2, counts as one too (DOR-4505)"
---

### Fixed

- More risky app actions now need to be picked for an agent one by one, and Read and write no longer covers them:
  - every change in PayPal Zettle and Moneybird, and in a new app whose name starts or ends with a word like pay, wallet, bank or coin, or that is a new version of a money app DorkOS already knows;
  - OAuth app actions with names like "createOAuthApp";
  - creating a branch and merging a pull request in Bitbucket, and new merge, branch, tag or release actions in GitHub, GitLab, Gitea and Bitbucket.

  Opening or editing a merge request stays in Read and write.
