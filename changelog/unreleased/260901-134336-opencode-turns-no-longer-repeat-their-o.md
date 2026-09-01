---
covers:
  - 'fix(server,shared,test-utils): stop turns echoing their own prompt, and birth turns indexing as user speech (DOR-1659, DOR-1669)'
---

### Fixed

- OpenCode agents no longer start every reply by reciting the setup notes DorkOS gives them, followed by a copy of your own message. The reply now begins with what the agent actually says
- An OpenCode agent posting in a room no longer opens its message with those setup notes — which included what other people in the room had said. Anything it already posted that way stays as it was; new posts are clean
- Summaries of scheduled task runs now show the first part of the agent's answer instead of the first part of its setup notes
- When an agent is created it is asked to introduce itself. That opening request came from DorkOS, not from you, and search now leaves it out for every agent whichever tool it runs on — so searching your history no longer turns up DorkOS's own instructions as though they were your words. Birth turns already in the search index stay there until the index is rebuilt; new sessions are clean from the start
