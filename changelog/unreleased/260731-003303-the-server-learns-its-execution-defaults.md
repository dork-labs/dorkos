---
covers:
  - 'feat(config): the server learns its execution defaults — model and effort, per runtime'
---

### Added

- Choose which model new chats start on, and how hard they think. Each runtime gets its own pair of settings, because a model name only means something to the runtime that offers it — so Claude Code, Codex and OpenCode each have their own. Leave them alone and nothing changes: every runtime keeps picking for itself, exactly as before. Set one and every new chat on that runtime starts there, while chats you already have keep what they are running with. OpenCode gets a model setting but no thinking setting, because OpenCode gives no way to ask for more or less thinking and we would rather say so than pretend. Room agents benefit most: until now a room reply had no way to say which model it should run on. **For now these live in `~/.dork/config.json`** (`runtimes.claudeCode.defaultModel` and friends) — the Settings screen for them is coming.
