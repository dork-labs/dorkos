---
covers:
  - 'fix(client): bring back an unsent community draft after switching away and back'
---

### Fixed

- A message you started in a community channel and did not send is now still there when you switch to another community, or back to this DorkOS, and then return. Files you attached to it come back too. Before, switching away threw the message away. It stays in that one channel of that one community, is never shown anywhere else, and is thrown away if you sign out or that community's connection ends (DOR-2241).
