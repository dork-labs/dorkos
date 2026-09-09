---
covers:
  - 'fix(server,client,shared,db): approval cards name what they act on (DOR-1929)'
  # Both fold in here rather than earning bullets of their own: they change this
  # same unreleased card and nothing a person could have seen before it.
  - 'refactor(shared,db,client): list only the subject kinds a resolver is wired to'
  - 'fix(server,client): address adversarial review of the approval subject'
---

### Fixed

- Approval cards now name the thing they would act on. Asking to remove an agent used to show only its id — a line like `agentId: "01KXQ3P7ADJY9DSXMZW1XGWCV4"` — so four requests in a row looked identical and there was no way to tell which agent was which. The card now leads with the agent's name, keeps the id underneath so you can still check it, and does the same for a scheduled task it would delete. If DorkOS can't look the name up, the card shows the id exactly as before.
- A request DorkOS can't put a name to now says where it came from — "Asked from a session on this computer", or "Asked by an app connected to DorkOS" — instead of the old "Requested without an agent identity", which sounded like the request came from nowhere.
