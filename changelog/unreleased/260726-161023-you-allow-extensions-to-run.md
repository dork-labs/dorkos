---
covers:
  - 'feat(extensions): a person approves an extension once before its code runs in the server (DOR-516)'
---

### Added

- You now decide which extensions may run their code inside DorkOS itself. Some extensions bring code that runs in DorkOS rather than only in your browser, and that code can reach anything on your computer DorkOS can reach. The first time one tries to run, it waits: Settings → Extensions shows it with an **Allow it to run** button. One click and you are done. After that, editing, testing, and reloading that extension all work with nothing further to click, and turning it off and on again does not ask you again. **Stop it** on the same card takes the permission back and stops the extension right away. Extensions that ship with DorkOS never ask, because you already installed DorkOS.
- Your agents can see which extensions you have allowed, but they cannot add to the list. An agent that could allow its own extension would be approving its own code, so that answer is yours alone, alongside your other protected settings.

### Fixed

- Reloading an extension you had turned off no longer quietly turns it back on. Asking DorkOS to reload a switched-off extension used to start it up again, routes and all, while the switch in Settings still showed it as off. DorkOS now says it is off and leaves it alone.

### Note for people upgrading

Extensions you installed before this update start out not allowed, and any that run code inside DorkOS will wait for you the first time. This is deliberate: DorkOS will not treat "you switched this on once" as "you read this code". Open Settings → Extensions and allow the ones you want. It is one click each, once.
