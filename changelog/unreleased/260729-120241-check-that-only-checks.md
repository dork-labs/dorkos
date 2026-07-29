---
covers:
  - 'fix(cli): harness sync --check no longer writes a file'
---

### Fixed

- `dorkos harness sync --check` no longer creates a file. Check is the mode that only reports, and the docs called it safe to run any time — but run it somewhere that has no harness manifest and it quietly wrote one, into whatever folder you happened to be standing in. It now stops, names the folder it searched, and leaves everything exactly as it found it (DOR-678).
- Three other ways into the same write are closed too. Plain `dorkos harness sync` with no flags, narrowing the run to one tool with `--harness`, and even naming a tool that does not exist all created that file first — so a command that went on to reject your input still left something behind. None of them write now.
- `--fix` still creates a manifest when a folder has none, which is what `--fix` is for. The built-in help now says plainly which mode writes and which never does, and reminds you that sync always acts on the folder you run it in — so if it cannot find a manifest, the usual answer is that you are one directory away from where you meant to be.
