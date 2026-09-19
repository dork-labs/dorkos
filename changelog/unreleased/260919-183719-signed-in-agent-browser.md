---
covers:
  - "feat(cli,server,client): sign in once, and every agent's browser starts signed in (DOR-2155)"
---

### Added

- Sign in to a website once and your agents' browsers start already signed in. Run `dorkos browser login github.com`, sign in in the orange-framed agent browser (your password manager works there as usual), and press Enter. Agents get the saved sign-in, never your password (DOR-2155)
- Give an agent the signed-in browser from its profile: Tools & MCP, then Signed-in browser. It works the same for Claude Code, Codex and OpenCode agents, and each session gets its own private browser, so agents working at the same time never trip over each other (DOR-2155)
- See which sites are saved with `dorkos browser status`, and take one away with `dorkos browser forget <site>`. The same saved sign-ins also work in the `claude`, `codex` and `opencode` command-line tools; the Signed-in Browser guide has the setup. Tested on macOS; Windows and Linux are not tested yet (DOR-2155)
