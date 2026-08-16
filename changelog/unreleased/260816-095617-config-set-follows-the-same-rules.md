---
covers:
  - 'fix(server,cli): `dorkos config set` goes through the same door the cockpit does, and every settings change lands in the log (DOR-1247)'
  - 'fix(server,cli): a consent door for the terminal, and reads that survive a data directory DorkOS cannot write to (DOR-1247)'
  - 'refactor(cli): split the config-write seam out of config-commands, and explain a save the filesystem refuses (DOR-1247)'
---

### Fixed

- Changing a setting from the command line now follows the same rules as changing it in DorkOS. `dorkos config set` used to write straight to your settings file, so it could turn on Full autonomy for every new session without ever asking you what that means. Now it asks, in the same words the app uses, and refuses until you say yes (DOR-1247)
- `dorkos config set` also checks the value before it saves. Typing something the setting cannot hold, or a setting that does not exist, tells you so instead of quietly writing it into the file and running on a default you were never told about (DOR-1247)
- Reading your settings works even when DorkOS cannot write to its own folder. `dorkos config get`, `list`, `path` and `validate` used to stop with a wall of technical text on a folder they had no permission to write in, which is often exactly when you are trying to find out what is wrong. They now show you what you asked for and say once, in plain words, what your computer refused (DOR-1247)
- Saving a setting to a folder DorkOS cannot write to now tells you so in one line, instead of a wall of technical text. Your settings are left as they were (DOR-1247)

### Changed

- Your log now names the setting that changed and where the change came from — `[Config] Patched by dorkos config set: …`. Settings used to move with nothing on disk that could say what moved them. Changing one in the app, with `dorkos config set`, or through one of your agents now leaves a line, and so do the parts of DorkOS that save a setting as a side effect, like starting a tunnel or turning on an extension. Setting names only, never their values, so your log is still safe to share (DOR-1247)
- Changing a setting with `dorkos config set` no longer says it succeeded when it didn't. It shows you the value that was actually saved, and tells you plainly when you've asked for something it can't do — a setting that doesn't exist, or one item of a list (DOR-1247)

### Added

- `dorkos config acknowledge-autonomy` reads you what starting every new session in Full autonomy means and asks you to confirm, so you can turn it on from the command line the same way you would in the app (DOR-1247)
