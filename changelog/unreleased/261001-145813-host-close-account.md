---
covers:
  - "feat(community): let a host close someone else's account"
  - 'fix(community): limit and log host account closures'
---

### Added

- A Community host can now close someone else's account, for example when the person is younger than the host's minimum age, or under a legal order. The person is signed out at once and cannot sign in, and their account is erased 72 hours later, the same wait a person's own request has. Until then the host can cancel it, and the person can sign in again. It needs a new host API key permission, `accounts:close`, and a host can find the account by the identity its single sign-on gives the person. Each person or key can close at most 10 accounts a day (`COMMUNITY_ACCOUNT_CLOSURES_PER_DAY`), and every closure writes a log line you can alert on. An account that still owns a community cannot be closed until its owner is replaced, and the erasure waits while the person belongs to a community under a legal hold. (DOR-2557)
