---
covers:
  - 'fix(config): a busy moment no longer wipes your settings'
---

### Fixed

- Your settings now survive a busy moment on your computer. When a computer has
  too many files open at once, reading a file can fail even though the file is
  perfectly fine. DorkOS used to read that as damage. It renamed your settings
  file and started over with defaults. One person lost their pinned status bar
  items that way. The riskiest moment was the first launch after an update,
  which is when DorkOS reads your settings the most.
- DorkOS now waits a moment and tries again. If it still cannot read your
  settings, it stops and tells you why, and it does not replace or delete
  them. Start DorkOS again once your computer is less busy and your settings come
  back.
- A settings file that really is broken is still backed up and rebuilt, and your
  privacy and safety choices still carry over to the new one. If this already
  happened to you, your old settings are in `~/.dork/config.json.bak`.
- When DorkOS does stop, it now tells you what to do about the actual problem.
  A full disk says to free up space. A file you are not allowed to open gives
  you the command to fix that, on Mac, Linux, or Windows. It no longer tells
  you to wait for a problem that will not pass on its own.
