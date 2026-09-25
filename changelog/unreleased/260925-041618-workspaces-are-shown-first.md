---
covers:
  - 'fix(workspaces): show a new workspace before anything runs there, and run its hooks only as shown (DOR-2335)'
---

### Security

- A new workspace is now checked before anything runs in it. A clone is read first: its settings files, the links it keeps and what its skills run. Your repository's workspace commands are shown with them. When you make a workspace that brings any of these, you see them first and then decide. When an agent asks for one, a person approves it on a card that shows them. Before, a cloned repository's settings ran in every session there and nobody saw them (DOR-2335)
- A workspace's cleanup commands are now the ones you saw when it was made. Changing the repository's workspace file afterwards no longer changes what runs when the workspace is removed (DOR-2335)
