---
covers:
  - 'feat(harness): every swept path says why (DOR-1895, DOR-1906)'
  - 'refactor(server): the asking half of auto-project stands alone (DOR-1895)'
  - 'feat(server): POST /api/harness/sync, for a person, never waiting on a card (DOR-1895)'
  - 'feat(client): the Sync button, and the banner that names what it removes (DOR-1895)'
  - 'fix(client): one failed sync, one toast (DOR-1895)'
  - 'fix(server): one harness router in the route suite, not two (DOR-1895)'
---

### Added

- Your agent's Skills page can now fix what it finds. When some of your agent files are out of date, a line at the top says so and offers a **Sync now** button that writes them, and the page updates to what the sync actually did rather than to a guess. Syncing sometimes also removes files — a link to a skill you deleted, the copies a package left behind when you uninstalled it — and the page names every one of those files, with a plain sentence saying why each is going, **before** you click, then lists them again afterwards so they do not vanish into a toast that fades. One line in that list is not a deletion at all: your own `.claude/settings.local.json` keeps every setting you wrote and loses only the entries DorkOS added, and it says so. If a package wants to run commands automatically, syncing does not wait for you to decide — the files that do not run code are shared straight away, an approval card goes up for the ones that do, and the page tells you a package is waiting. Only you can press the button: an agent asking on your behalf is turned down (DOR-1895)

### Changed

- `dorkos harness sync` now says why each file it removes is going, on the line for that file, in both `--check` and `--fix`. It used to print the paths under one heading — "what they came from is gone" — which was true of most of them and not all: a skill link, an uninstalled package's command, a hooks file nothing writes to any more and a settings file that survives are four different things, and now each says which it is. The app shows the same sentences, word for word (DOR-1895, DOR-1906)
