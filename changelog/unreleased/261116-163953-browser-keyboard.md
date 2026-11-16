---
covers:
  - 'feat(client): the Agent browser knows the usual browser keys (DOR-4432)'
  - 'fix(client): Esc in the Agent browser never closes the side panel around it (DOR-4432)'
  - 'refactor(desktop): the page transport cannot be made without its input gate (DOR-4432)'
---

### Added

- **The Agent browser knows the usual browser keys.** ⌘L, ⌘R and ⌘⇧C work in the browser and in its page. ⌘[ and ⌘] go back and forward, and Esc stops a load, from the browser's own bar. Inside the page those keys stay the page's, as in Chrome. Esc in the browser never closes the side panel around it. Outside the browser, ⌘[ and ⌘] still move between your app tabs. The matching Windows and Linux keys work too. (DOR-4432)
