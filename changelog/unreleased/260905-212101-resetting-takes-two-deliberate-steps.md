---
covers:
  - 'fix(server,client): resetting DorkOS requires a fresh one-time token (DOR-1707)'
  - 'fix(server,client): a refused reset costs nothing, and its deadline is stated once (DOR-1707)'
---

### Security

- Resetting DorkOS — the button that deletes everything it has stored — now takes a deliberate two-step confirmation, so nothing else on your machine can trigger it with one hidden request. Before this, any program that could reach the DorkOS API could delete your whole `~/.dork` folder with a single message, because the only thing the reset asked for was a word that is written in DorkOS's own source code. Now DorkOS hands out a one-time code the moment you press the button, and the reset only happens if that exact code comes back within two minutes. Nothing changes about how you reset: type "reset", press the button, done (DOR-1707)
