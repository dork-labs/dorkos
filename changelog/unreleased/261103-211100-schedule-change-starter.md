---
covers:
  - 'fix(tasks): track steering in schedule change attribution (DOR-3848)'
  - 'fix(tasks): reserve person attribution for stamped app turns (DOR-3848)'
  - 'fix(tasks): clarify current-turn notice attribution (DOR-3848)'
  - 'fix(tasks): name the current turn in schedule change notices (DOR-3848)'
---

### Fixed

- A schedule’s permissions notice now names the message that started the change, including Telegram and Slack. This also covers bridged rooms and keeps a later turn in the app from carrying the earlier source.
