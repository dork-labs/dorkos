### Added

- Skills can ship reusable widget templates under `ui/*.widget.json` — a named, described widget document with `{{placeholder}}` slots an agent fills in before emitting it as a `dorkos-ui` fence, instead of hand-rolling document JSON every turn.
- The `<gen_ui>` teaching block now tells every runtime (Claude Code, Codex, OpenCode) to check a skill's `ui/` directory for templates and fill their placeholders.
- Skill validation now catches malformed `ui/*.widget.json` files as structural errors instead of silently ignoring them.
