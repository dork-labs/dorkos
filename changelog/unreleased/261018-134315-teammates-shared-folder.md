---
covers:
  - "feat(spaces): share one folder with teammates' turns in a space, and give them public notes (DOR-2956)"
---

### Added

- The **Teammates** section of a space's agent panel now has a **Shared folder**. When a teammate in that space wakes one of your agents, the agent can list, search and open the files in that folder. Its requests to read other files are refused. Nothing is shared until you pick a folder. A folder that holds DorkOS's data, Claude's settings, an agent, or your whole home folder can't be shared.
- Some files are never read, even inside the shared folder: `.env` files, keys and other credential files (such as `.pem`, `.key`, `id_*`, `.npmrc`, `.netrc` and `.mcp.json`), the `.git`, `.dork`, `.claude` and `.ssh` folders, and any file over 1 MB. A shortcut that points outside the folder isn't followed. If the shared folder is later replaced by a shortcut, nothing in it is read until you share it again.
- Each agent can have public notes: write them in its `.dork/PUBLIC.md`, and a teammate's turn is shown them. Your agent's own memory is still never shown to a teammate.

### Changed

- When a teammate wakes your agent, the turn runs from an empty folder of its own instead of the agent's folder, so it isn't told where your agent's files are or what state its git branch is in.
