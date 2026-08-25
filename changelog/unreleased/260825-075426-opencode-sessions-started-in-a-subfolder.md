---
covers:
  - 'fix(server,client): OpenCode sessions started in a subdirectory appear in the list (DOR-674)'
---

### Fixed

- OpenCode sessions you started in a subfolder now show up under the project they belong to. If you ran `opencode` in something like `my-app/packages/api`, that conversation was missing from `my-app` — and from every other project too, so there was nowhere to find it. It now appears everywhere a project's sessions are listed: the sidebar switcher, the agent's Sessions page, the command palette, the embedded sidebar, and the Recent list. Each session still shows the folder it is actually running in. Claude Code sessions in subfolders have the same blind spot in their own listing; that fix is tracked separately. (DOR-674)
- An OpenCode agent that was working in a subfolder no longer looks idle. Its last-active time and its daily run counts skipped those sessions. (DOR-674)
