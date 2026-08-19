---
covers:
  - 'feat(shared,server): carry who answered an Ask from the route to the wire (DOR-1355)'
  - 'feat(client): a receipt says who answered when DorkOS knows the name (DOR-1355)'
  - 'fix(server,docs): sanitize the account name and never 500 an answer over it (DOR-1355 review)'
---

### Changed

- Answer an agent's question in one window and the other windows now say who answered it: "Already answered by Ada at 2:01". DorkOS uses the name on your account, or the name you told it to call you. When it knows neither, the card still says when the question was answered. (DOR-1355)
