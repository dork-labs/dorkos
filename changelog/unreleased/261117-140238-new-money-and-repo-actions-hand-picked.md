---
covers:
  - 'fix(connections): new money apps, OAuth actions and repository merges, tags and releases stay one-by-one picks by name (DOR-4505, DOR-4506, DOR-4509)'
---

### Fixed

- More risky actions now need to be picked for an agent one by one, even before DorkOS has reviewed them. This covers PayPal Zettle and any new app whose name says pay, wallet, bank or coin. It also covers OAuth app actions with names like "createOAuthApp", and new merge, branch, tag or release actions in GitHub, GitLab, Gitea and Bitbucket. Opening or editing a merge request stays an ordinary write.
