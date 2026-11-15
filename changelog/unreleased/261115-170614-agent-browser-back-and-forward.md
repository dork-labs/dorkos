---
covers:
  - "feat(browser): the Agent browser's Back and Forward move the page's real history (DOR-4449)"
---

### Added

- Back and Forward work in the Agent browser, in the app and in the Mac app. They follow the page's own history and turn off when there is nowhere to go.
- Pressing Back or Forward while an agent is using the page takes it over: the agent pauses first, so the two of you never move the page at once.

### Security

- Back and Forward follow the same address rules as typing an address. They never open DorkOS itself, local files or other non-web addresses, and they skip pages like that in the history.
- A page that was fine when you visited it but now redirects somewhere refused is stopped before it loads, and you stay on the page you were on.
