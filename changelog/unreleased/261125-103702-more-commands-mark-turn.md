---
covers:
  - 'fix(agents): scripts that fetch from the network, and more ways of naming outside files, mark the turn (DOR-5240)'
---

### Fixed

- When an agent runs a script file that fetches from the internet, such as `python3 fetch.py` or `./get.sh`, a send through a connected app later in that turn needs your OK, the same as after `curl`. The same goes for files in your temp or Downloads folder named in other ways, like after a `cd` or with a wildcard, and for a Codex command whose output arrives in a later turn.
- The shell check reads each command after a heredoc on its own, so its protections apply there too.
