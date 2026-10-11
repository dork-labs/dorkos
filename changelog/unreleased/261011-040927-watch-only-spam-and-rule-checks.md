---
covers:
  - 'feat(community): watch-only spam and rule checks on posts (DOR-2777)'
  - 'fix(community): post checks keep to their own pool, cap their flags and spare private channels (DOR-2777)'
  - 'fix(community): build the decisions package wherever the Community server is built (DOR-2777)'
---

### Added

- A space now checks each new post for spam, and against the space's rules, after the post is up. A post that looks wrong is flagged for the owner and admins with a short note on why. Checks never hide, hold or remove a post, and never slow one down (DOR-2777)
- Owners and admins see what each check made of a flagged message, and can list only the messages the checks flagged (DOR-2777)
- A server can ask Jev and one OpenAI-format model the same questions about the same posts, and compare how often each agreed with moderators, what it cost and how long it took. These calls cost money, so they only run when the server sets `COMMUNITY_DECISIONS_PAID=1` beside each model's key, and stop for the day at a call limit. Without that, only free built-in checks run. Messages in private channels never go to these models (DOR-2777)
