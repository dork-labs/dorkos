---
covers:
  - 'feat(extensions): a person approves an extension once before its code runs in the server (DOR-516)'
  - 'fix(extensions): close two ways around the extension load gate (DOR-516)'
  - "fix(extensions): the origin bar has to use the server's own allowlist (DOR-516)"
---

### Added

- You now decide which extensions may run their code inside DorkOS. That covers both halves of an extension: the part that runs on your computer, which can reach anything DorkOS can reach, and the part that runs on the DorkOS page in your browser, signed in as you. Until you say yes, neither one runs. The first time an extension tries, it waits: Settings → Extensions shows it with an **Allow it to run** button. One click and you are done. After that, editing, testing, and reloading that extension all work with nothing further to click, and turning it off and on again does not ask you again. **Stop it** on the same card takes the permission back and stops the extension right away. Extensions that ship with DorkOS never ask, because you already installed DorkOS.
- Your agents can see which extensions you have allowed, but they cannot add to the list. An agent that could allow its own extension would be approving its own code, so that answer is yours alone, alongside your other protected settings. The same limit applies as to those: with **Require login** off, which is the default, this holds against any agent that says who it is, and turning **Require login** on closes the rest.
- Updating or reinstalling an extension asks you again. New code is a new decision, even under a familiar name. Editing an extension you already allowed never re-asks, so building your own is still one click, once.
- A web page you visit cannot allow an extension for you. Requests to allow or stop an extension now have to come from DorkOS itself.

### Fixed

- Reloading an extension you had turned off no longer quietly turns it back on. Asking DorkOS to reload a switched-off extension used to start it up again, routes and all, while the switch in Settings still showed it as off. DorkOS now says it is off and leaves it alone.
- A folder in your project can no longer take the place of an extension DorkOS ships, or of one you already allowed. DorkOS decides what counts as its own code by where that code sits on disk, not by the name inside it.

### Note for people upgrading

Extensions you installed before this update start out not allowed, and they wait for you the first time. This is deliberate: DorkOS will not treat "you switched this on once" as "you read this code". Open Settings → Extensions and allow the ones you want. It is one click each, once. Until then an extension you have not allowed will not show up in DorkOS at all, so if something you use has gone missing, that is where it went.
