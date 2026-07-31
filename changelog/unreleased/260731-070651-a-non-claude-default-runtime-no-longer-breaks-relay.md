---
covers:
  - 'fix(runtimes): the relay stops following the default runtime'
---

### Fixed

- **Choosing a default runtime other than Claude Code no longer silences your agents on chat platforms.** `dorkos config set runtimes.default opencode` is a documented setting, but it also reached the relay — the part of DorkOS that carries messages between your agents and Telegram, Slack, and the like. The relay only knows how to talk to Claude Code, so a different default left it with nothing it could use, and it switched message routing off during startup with nothing you would ever see in the app. The server looked healthy, the chat connection looked connected, and messages went nowhere. The relay now uses Claude Code directly whatever your default is, and where it genuinely has to make a choice it writes that choice to the log instead of going quiet.
