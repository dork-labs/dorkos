---
covers:
  - 'feat(client): the Agent browser says who has the page, and using it takes the page (DOR-4428)'
  - 'fix(client): the browser pill says when no page is open yet, and its phone sheet title lines up (DOR-4428)'
  - "refactor(dev): the Agent browser's playground sections get their own file"
  - 'feat(client): the canvas browser and the Agent browser share one browser chrome (DOR-4427)'
  - "fix(client): address rules search pasted errors and keep the canvas's local files (DOR-4419)"
  - 'feat(client): the browser address bar reads what you type the way a browser does (DOR-4419)'
---

### Changed

- The Agent browser now shows who has the page in one small label beside the address: the agent, Paused, Your turn, You or Only you. Press it for the agent's controls: Take over, Pause, Resume and Hand back. On a phone they open as a sheet from the bottom.
- When an agent asks you to sign in, the label turns orange and names the real site the page is on, never words the agent wrote.

### Added

- Reloading, stopping or typing an address in the Agent browser while an agent uses it now takes the page for you in one step. The agent can't see or use the page until you hand it back.
