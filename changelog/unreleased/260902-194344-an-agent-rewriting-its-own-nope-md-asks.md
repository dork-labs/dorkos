---
covers:
  - 'fix(server,client,docs): an agent changing its own NOPE.md asks a person first (DOR-1698)'
---

### Fixed

- Changing an agent's safety boundaries — its NOPE.md, the list of things you told it never to do — now asks you first. An agent could rewrite that file through its own agent-update tool with nothing shown to anyone, and it could also switch the whole list off without touching a word of it. Either way, the limits you set stopped applying and nothing said so. Both changes are now one action that waits for your approval, and the card shows you the full new text rather than the first line of it. Editing boundaries yourself in the app is unchanged (DOR-1698)
