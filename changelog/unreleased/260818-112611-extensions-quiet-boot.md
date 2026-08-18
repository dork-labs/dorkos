---
covers:
  - "fix(server): extensions stop restarting on every page load and stop warning about DorkOS' own bundled extensions"
  - 'fix(shared,server): a key you save in Settings reaches the running extension right away, and a broken extension says so (DOR-1336 review)'
---

### Fixed

- Extensions no longer restart every time you open DorkOS or open a new tab. Each browser tab used to ask the server to start the extensions again, which shut down the running ones and started them over — seconds after launch, and again on every tab. DorkOS now leaves an extension alone when nothing about it has changed, and only restarts it when its code actually changed or you ask for a reload. (DOR-1336)
- Running DorkOS from your home folder no longer fills the log with warnings about its own bundled extensions. When your working folder is the one that holds DorkOS's own settings, DorkOS was reading its extensions folder twice and mistaking its own extensions for project copies of themselves. It now reads that folder once. (DOR-1336)
- An API key you save for an extension now works straight away. Extensions read their saved keys fresh every time, so pasting a key in Settings no longer needs a DorkOS restart before the extension can use it. (DOR-1336)
- An extension whose code stops building now says so on its card in Settings, with the error, instead of looking healthy while DorkOS quietly keeps running the last version that worked. (DOR-1336)
