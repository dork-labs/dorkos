---
covers:
  - 'fix(shared): say one-to-one chat, not direct chat, in the agent memory rules (DOR-2134)'
---

### Fixed

- An agent's memory rules now say that only you, in a one-to-one chat with the agent, can set its standing preferences. They used to say "a direct chat", which a group direct message with someone else in it also fit, so another person there could have passed as you. The preview on the agent's profile shows the new wording. (DOR-2134)
