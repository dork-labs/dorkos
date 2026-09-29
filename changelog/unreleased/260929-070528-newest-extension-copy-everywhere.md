---
covers:
  - 'feat(extensions): run the newest copy of an extension in every project, and trust a source once (DOR-2527)'
  - "fix(extensions): prove a copy's origin by its content, and move every re-scan onto the new copy (DOR-2527)"
  - 'fix(extensions): vouch for the whole plugin folder, check it at every load, and never stall on a hung extension (DOR-2527)'
  - 'fix(extensions): run origin-trusted copies from a verified snapshot, cache folder digests, and dispose a hung start (DOR-2527)'
  - 'fix(extensions): pin "Stop trusting" to each copy''s digest and run it from its snapshot (DOR-2527)'
  # This branch was stacked on DOR-2522's own commits, which main took as one
  # squashed PR (#2326) whose entry already shipped in v0.92.0.
  - 'feat(server): know every project by one short name, and every item a chat works on (DOR-2522)'
  - "fix(server): keep the live session stream off git, and trackerItem to this chat's own run (DOR-2522)"
  - 'fix(server): keep outside repositories and extension-named folders out of the project list (DOR-2522)'
  - 'fix(server): hold the project cap under bursts, and answer null on a storage clash (DOR-2522)'
---

### Changed

- When the same extension is installed in several projects, DorkOS now runs the newest copy everywhere instead of whichever project it opened first. You say yes to it once, not once per project (DOR-2527)

### Added

- Right after you turn on an extension, the inbox can offer "Next time, trust everything from dork-labs/marketplace?". Say yes and extensions DorkOS installs from there turn on without asking. Only you can do this, and you can undo it in Settings → Extensions → Trusted sources (DOR-2527)

### Security

- An extension only counts as coming from a place when DorkOS installed it from a branch or tag there and its files are still exactly what was installed. If anything in the plugin changes afterwards, for example by a `git pull`, it asks you again before it runs, and Settings → Extensions says why (DOR-2527)
- An extension you trust through another project runs from a checked copy that DorkOS keeps for itself, so editing the files in the project can't change what runs (DOR-2527)
