---
covers:
  - 'feat(community): a space keeps no sign-in provider tokens, and asks a DorkOS account only who you are (DOR-2957 part 3)'
  - 'chore(community): say the DorkOS scope limit follows the sign-in mark, and keep its constants private (DOR-2957)'
---

### Changed

- When you sign in to a space with Google, GitHub or a DorkOS account, the space now keeps only who you are. It no longer stores the access that provider gave it, so it can't act in that account. Access stored before this release is deleted when the space server upgrades (DOR-2957)
- If you run your own space server and sign people in with a DorkOS account: `COMMUNITY_OIDC_SCOPES` may ask only for `openid`, `email` and `profile` when `COMMUNITY_OIDC_MARK` is `dorkos`. Set that mark whenever your sign-in is a DorkOS account. The server won't start with any other scope (DOR-2957)
