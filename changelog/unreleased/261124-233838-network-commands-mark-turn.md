---
covers:
  - 'fix(agents): commands that fetch from the network mark the turn as carrying outside words (DOR-5236)'
---

### Fixed

- When an agent runs a command that fetches from the internet, such as curl, gh, npx or git pull, a send through a connected app later in that turn needs your OK, the same as after it reads a web page. So does reading or searching files in a temp folder, your Downloads folder or a room's attachments. Everyday commands like git status or running tests don't change anything.
