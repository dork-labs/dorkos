---
covers:
  - 'fix(client): the Team tab says "needs you" when its dot does (DOR-3533)'
---

### Fixed

- When an agent was waiting on you, the Team tab showed an amber "needs you" dot but still read "Team · 3 working", so amber looked like it meant "working". Now the label says the same thing as the dot: "Team · 1 needs you" (or "2 need you"). The working count moves to the hover text: "1 agent is waiting on you · 3 working". When nobody is waiting, it still reads "Team · 3 working" with the green dot. (DOR-3533)
