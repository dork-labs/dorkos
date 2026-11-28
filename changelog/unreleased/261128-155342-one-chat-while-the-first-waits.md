---
covers:
  - 'fix(chat): messages to an agent whose new chat still waits join that chat (DOR-5512)'
---

### Fixed

- When an agent sends several messages to another agent while their new chat is still waiting for a free slot, they now all land in that one chat, in the order sent, instead of each opening a chat of its own. They run one after another once the first starts. (DOR-5512)
