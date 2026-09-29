---
covers:
  - 'feat(extensions): let an extension ask a person in the inbox (DOR-2523)'
  - 'feat(inbox): draw what extensions ask, grouped by project (DOR-2523)'
  - 'fix(extensions): show a decision raised into a missing folder once the folder is back (DOR-2523)'
---

### Added

- Extensions can now ask you things in the Activity inbox. Every question says why it is asking, and you can answer it right there. A question can come with the agent's own pick and a time: if you haven't answered by then, the agent goes ahead with its pick, so nothing waits on you. After you answer, an extension can offer once to handle that kind of thing on its own next time. (DOR-2523)
- When things from two or more projects are waiting, the inbox now groups them under each project's name. (DOR-2523)
- Decisions an extension made while you were away now fold into one "While you were away" line in Activity, and each one says who decided: you, the agent, or a setting of yours. (DOR-2523)
