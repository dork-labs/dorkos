---
covers:
  - 'fix(security): only the person running DorkOS can add a package source (DOR-502)'
  - 'fix(cli): print what to do next when a package-source write is refused (DOR-502)'
---

### Security

- Only you can change where DorkOS gets packages from. A marketplace source is a place DorkOS will download and run code from, so an agent that tries to add or remove one is now turned down with a plain refusal telling it to ask you instead. There is no card and no way for it to say yes. Adding and removing sources still works normally from your own terminal and from the Marketplace sources screen, and agents can still list, refresh, and validate sources and install from the ones you already added (DOR-502)
