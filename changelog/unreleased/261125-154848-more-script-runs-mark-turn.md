---
covers:
  - 'fix(agents): more ways of running a script, searching a folder and naming a file mark the turn (DOR-5261)'
  - 'fix(agents): searches read past the attachments ignore file only when rg does (DOR-5261)'
---

### Fixed

- When an agent runs a script that fetches from the internet in more of the usual ways, such as `source ./get.sh`, `pnpm exec tsx fetch.ts`, `uv run fetch.py`, `cat fetch.py | python3`, or a project script like `pnpm run sync` or `make deploy`, a send through a connected app later in that turn needs your OK, the same as after `curl`. A script that runs `gh` or `curl` from its own code counts too.
- A search of an agent's folder that reaches the room attachments copied there counts as reading them, and more ways of starting a search, such as `find -x ~` or `grep -d recurse`, are read correctly. The agent's usual code search leaves those copies out, so searching its own project doesn't count.
