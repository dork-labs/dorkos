---
covers:
  - "fix(server): extensions stop restarting on every page load and stop warning about DorkOS' own bundled extensions"
  - 'fix(shared,server): a key you save in Settings reaches the running extension right away, and a broken extension says so (DOR-1336 review)'
  - 'fix(server,client): a failed server-side rebuild no longer hides the extension its own screen (DOR-1336 review round 2)'
---

### Fixed

- Extensions no longer restart every time you open DorkOS or open a new tab. Each browser tab used to ask the server to start the extensions again, which shut down the running ones and started them over — seconds after launch, and again on every tab. DorkOS now leaves an extension alone when nothing about it has changed, and only restarts it when its code actually changed or you ask for a reload. (DOR-1336)
- Running DorkOS from your home folder no longer fills the log with warnings about its own bundled extensions. When your working folder is the one that holds DorkOS's own settings, DorkOS was reading its extensions folder twice and mistaking its own extensions for project copies of themselves. It now reads that folder once. (DOR-1336)
- An API key you save for an extension now works straight away. Extensions read their saved keys fresh every time, so pasting a key in Settings no longer needs a DorkOS restart before the extension can use it. (DOR-1336)
- When the background half of an extension stops building, its card in Settings now says so — "Server side failed to rebuild… the previous version is still running" — instead of looking perfectly healthy while DorkOS quietly runs the last version that worked. The rest of the extension, including the part you see on screen, keeps working while you fix it. (DOR-1336)
