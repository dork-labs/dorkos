### Added

- Run Codex and OpenCode agents next to Claude Code, all in one cockpit. Every session shows which runtime it belongs to, and the session list keeps working even when one runtime is down. (#75, ADR-0309, ADR-0308)
- Switch runtimes right from the chat composer: pick Claude Code, Codex, or OpenCode for a new session, and DorkOS remembers the choice per session. (#78)
- Connect a runtime account without leaving DorkOS: guided connect flows check what's installed, walk you through login, and store credentials as secure references (never plaintext). (#79, ADR-0315)
- DorkOS now detects which runtimes are installed on your machine and offers the ones that are ready, so getting a second runtime running takes one click instead of a config file. (#80, DOR-183)
