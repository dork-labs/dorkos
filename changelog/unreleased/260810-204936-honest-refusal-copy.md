---
covers:
  - 'fix(server): an agent refused a setting is told what that setting actually does (DOR-1044)'
---

### Fixed

- When an agent asks to change a setting only you may change, the refusal now says what
  that setting really is. It used to tell every agent the same thing — that the setting
  decides who can reach your instance, where your keys go, and what leaves your machine
  — which is true of your login switch and untrue of a room's reply limit or the
  welcome-back greeting cap. Those bounds are about how often your agents speak on their
  own and what that spends, so that is what the refusal says now, and a request touching
  several kinds of setting gets one honest line for each (DOR-1044)
