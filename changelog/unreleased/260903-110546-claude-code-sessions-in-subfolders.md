---
covers:
  - 'fix(server,client): a project lists the sessions started inside it (DOR-1550)'
  - "fix(server): one unreadable project folder no longer truncates an account's listing (DOR-1550)"
---

### Fixed

- Claude Code sessions you started in a subfolder now show up under the project they belong to. If you ran `claude` in something like `my-app/packages/api`, that conversation was missing from `my-app` — the same blind spot OpenCode had, and the last one left. Each session still shows the folder it is actually running in. (DOR-1550)
- An agent whose open conversation is running in a subfolder now lights up in the sidebar instead of looking closed. (DOR-1550)
