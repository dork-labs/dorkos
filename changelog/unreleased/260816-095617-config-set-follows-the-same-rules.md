---
covers:
  - 'fix(server,cli): `dorkos config set` goes through the same door the cockpit does, and every settings change lands in the log (DOR-1247)'
---

### Fixed

- Changing a setting from the command line now follows the same rules as changing it in DorkOS. `dorkos config set` used to write straight to your settings file, so it could turn on Full autonomy for every new session without ever asking you what that means. Now it asks, in the same words the app uses, and refuses until you say yes (DOR-1247)
- `dorkos config set` also checks the value before it saves. Typing something the setting cannot hold, or a setting that does not exist, tells you so instead of quietly writing it into the file and running on a default you were never told about (DOR-1247)

### Changed

- Your log now names what changed a setting and where the change came from — `[Config] Patched by dorkos config set: …`. Settings used to move with nothing on disk that could say what moved them; the app, the command line, your agents, and the parts of DorkOS that save a setting as a side effect all leave a line now. Settings names only, never their values, so a log is still safe to share (DOR-1247)
