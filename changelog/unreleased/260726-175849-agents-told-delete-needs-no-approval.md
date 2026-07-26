---
covers:
  - 'fix(skills): agents were told a destructive delete needs no approval (DOR-509)'
  - 'fix(skills): correct three more absolute claims found in review (DOR-509)'
---

### Fixed

- Your agents were being given wrong information about which actions stop to ask you. The built-in instructions every agent is set up with said that deleting a scheduled task "carries no gate of its own", and the tool catalog that agents read to learn what they can do said that a whole group of DorkOS tools carries no permission level at all. Neither was true. Deleting a scheduled task and removing an agent have both stopped and asked you since they were classified, and every tool in that group has a permission level. The protection was never missing; the description of it was wrong (DOR-509)
- An agent that believed those descriptions would not warn you before an action it could not undo, and would read your refusal as something broken rather than as your answer. The instructions now say plainly which actions wait for you, how to ask, and that a refusal is the answer. Existing agents pick up the corrected version automatically the next time DorkOS sets them up; a copy you edited yourself is left alone, as always (DOR-509)
- The same instructions had three other details wrong: they named only two of the three actions that stop to ask you, they said removing an agent could only be done one way, and they said every command accepts the `--json` option when several reject it. All three are corrected (DOR-509)
